"""Candidate operations adapter for ProtClaw.

Two modes of operation:
  - "cluster": Sequence clustering using scikit-learn (e.g., k-means on features)
  - "rank": Pareto ranking of candidates by multiple objectives

Input: list of candidate scores/features.
Output: cluster assignments or ranked list.

Pipeline integration:
  When called from a pipeline, _upstream_results contains metrics from
  structure_qc and developability_check. If no explicit `candidates` list
  is provided, the adapter auto-constructs one from upstream results.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult

logger = logging.getLogger(__name__)


def _build_candidates_from_upstream(
    upstream_results: dict[str, Any],
    input_dir: str,
) -> list[dict[str, Any]]:
    """Construct candidates list from upstream QC + developability results.

    Reads JSON report files from input_dir/files/ if available,
    otherwise falls back to metrics in _upstream_results.
    """
    candidates: list[dict[str, Any]] = []

    # Try to read developability report for per-sequence data
    dev_report_path = os.path.join(input_dir, "developability_report.json")
    dev_sequences: list[dict[str, Any]] = []
    if os.path.isfile(dev_report_path):
        try:
            with open(dev_report_path) as f:
                dev_data = json.load(f)
            dev_sequences = dev_data.get("sequences", [])
        except (json.JSONDecodeError, OSError):
            pass

    # Try to read QC report for structural metrics
    qc_report_path = os.path.join(input_dir, "qc_report.json")
    qc_metrics: dict[str, Any] = {}
    if os.path.isfile(qc_report_path):
        try:
            with open(qc_report_path) as f:
                qc_metrics = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass

    # If no file-based data, try upstream_results metrics
    if not dev_sequences:
        for node_id, node_data in upstream_results.items():
            metrics = node_data.get("metrics", {}) if isinstance(node_data, dict) else {}
            if "sequences" in metrics and isinstance(metrics["sequences"], list):
                dev_sequences = metrics["sequences"]
                break

    if not qc_metrics:
        for node_id, node_data in upstream_results.items():
            metrics = node_data.get("metrics", {}) if isinstance(node_data, dict) else {}
            if "rmsd_angstrom" in metrics:
                qc_metrics = metrics
                break

    # Build candidate list
    if dev_sequences:
        for i, seq_data in enumerate(dev_sequences):
            candidate: dict[str, Any] = {
                "name": seq_data.get("sequence_name", f"candidate_{i}"),
                "sequence_length": seq_data.get("sequence_length", 0),
                "molecular_weight_da": seq_data.get("molecular_weight_da", 0),
                "isoelectric_point": seq_data.get("isoelectric_point", 0),
                "mean_hydrophobicity": seq_data.get("mean_hydrophobicity", 0),
                "aggregation_propensity": seq_data.get("aggregation_propensity", 0),
            }
            # Add QC metrics (shared across all candidates from same structure)
            if qc_metrics:
                candidate["rmsd_angstrom"] = qc_metrics.get("rmsd_angstrom", 0)
                candidate["clash_score"] = qc_metrics.get("clash_score", 0)
            candidates.append(candidate)
    elif qc_metrics:
        # Only QC data, create a single candidate
        candidates.append({
            "name": "candidate_0",
            "rmsd_angstrom": qc_metrics.get("rmsd_angstrom", 0),
            "clash_score": qc_metrics.get("clash_score", 0),
        })

    logger.info("Auto-constructed %d candidates from upstream results", len(candidates))
    return candidates


class CandidateOpsAdapter(BaseTool):
    """Adapter for candidate clustering and ranking operations."""

    tool_name = "candidate_ops"
    tool_version = "1.1.0"

    DEFAULTS: dict[str, Any] = {
        "n_clusters": 5,
        "rank_objectives": None,  # List of metric names to rank by
        "rank_directions": None,  # "maximize" or "minimize" per objective
    }

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate candidate operations input parameters.

        Required:
            mode: str - "cluster" or "rank"
            candidates: list[dict] - List of candidate score dictionaries
                (or auto-constructed from _upstream_results if not provided)

        For mode="cluster":
            feature_keys: list[str] - Keys in candidate dicts to use as features
                (auto-detected from candidate keys if not provided)
            n_clusters: int - Number of clusters (default: 5)

        For mode="rank":
            rank_objectives: list[str] - Metric names to rank by
                (auto-set to common objectives if not provided)
            rank_directions: list[str] - "maximize" or "minimize" per objective
                (auto-set based on objective names if not provided)
        """
        validated = dict(self.DEFAULTS)
        validated.update(params)

        # Required: mode
        mode = validated.get("mode")
        if mode not in ("cluster", "rank"):
            raise ValueError(f"'mode' must be 'cluster' or 'rank', got: {mode}")
        validated["mode"] = mode

        # candidates: required, but can be auto-constructed in execute()
        candidates = validated.get("candidates")
        if candidates is not None:
            if not isinstance(candidates, list):
                raise ValueError("'candidates' must be a list of dicts")
            for i, c in enumerate(candidates):
                if not isinstance(c, dict):
                    raise ValueError(f"candidates[{i}] must be a dict, got {type(c).__name__}")

        if mode == "cluster":
            feature_keys = validated.get("feature_keys")
            if feature_keys is not None:
                if not isinstance(feature_keys, list):
                    raise ValueError("'feature_keys' must be a list")
                validated["feature_keys"] = [str(k) for k in feature_keys]

            n_clusters = int(validated["n_clusters"])
            if n_clusters < 1:
                raise ValueError(f"n_clusters must be >= 1, got {n_clusters}")
            validated["n_clusters"] = n_clusters

        elif mode == "rank":
            objectives = validated.get("rank_objectives")
            if objectives is not None:
                validated["rank_objectives"] = [str(o) for o in objectives]

            directions = validated.get("rank_directions")
            if directions is not None:
                validated["rank_directions"] = [str(d) for d in directions]

        return validated

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute candidate operations (cluster or rank).

        If candidates are not explicitly provided, auto-constructs them
        from _upstream_results (pipeline mode).
        """
        mode = params["mode"]
        candidates = params.get("candidates")

        # Auto-construct candidates from upstream results if not provided
        if not candidates:
            upstream = params.get("_upstream_results", {})
            if upstream:
                candidates = _build_candidates_from_upstream(upstream, input_dir)
            if not candidates:
                return self.build_error_result(
                    "No candidates provided and could not auto-construct from upstream results"
                )

        if mode == "cluster":
            return self._execute_cluster(params, candidates, output_dir)
        else:
            return self._execute_rank(params, candidates, output_dir)

    def _execute_cluster(
        self, params: dict[str, Any], candidates: list[dict[str, Any]], output_dir: str
    ) -> ToolResult:
        """Cluster candidates by feature similarity using KMeans."""
        feature_keys = params.get("feature_keys")
        n_clusters = params["n_clusters"]

        # Auto-detect numeric feature keys if not provided
        if not feature_keys and candidates:
            SKIP_KEYS = {"name", "sequence", "cluster_id", "pareto_front", "rank", "notes"}
            feature_keys = [
                k for k, v in candidates[0].items()
                if k not in SKIP_KEYS and isinstance(v, (int, float))
            ]
            logger.info("Auto-detected feature keys: %s", feature_keys)

        if not feature_keys:
            return self.build_error_result("No feature_keys provided and none auto-detected")

        # Adjust n_clusters to not exceed candidates
        if n_clusters > len(candidates):
            n_clusters = max(1, len(candidates))

        try:
            import numpy as np
            from sklearn.cluster import KMeans
            from sklearn.preprocessing import StandardScaler
        except ImportError as e:
            # Fallback to round-robin if scikit-learn not available
            import logging
            logging.getLogger(__name__).warning(
                "scikit-learn not available (%s), using round-robin fallback", e
            )
            clustered_candidates = []
            for i, candidate in enumerate(candidates):
                entry = dict(candidate)
                entry["cluster_id"] = i % n_clusters
                clustered_candidates.append(entry)

            output_path = os.path.join(output_dir, "cluster_results.json")
            with open(output_path, "w") as f:
                json.dump({
                    "mode": "cluster",
                    "n_clusters": n_clusters,
                    "feature_keys": feature_keys,
                    "candidates": clustered_candidates,
                    "method": "round_robin_fallback",
                }, f, indent=2)

            return self.build_result(
                status="success",
                output_files=[output_path],
                metrics={
                    "mode": "cluster",
                    "n_clusters": n_clusters,
                    "num_candidates": len(clustered_candidates),
                    "method": "round_robin_fallback",
                },
            )

        # Build feature matrix
        X = np.array([
            [float(c.get(k, 0)) for k in feature_keys]
            for c in candidates
        ])

        # Scale features for fair distance computation
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        # Run KMeans clustering
        kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
        labels = kmeans.fit_predict(X_scaled)

        clustered_candidates = []
        for i, candidate in enumerate(candidates):
            entry = dict(candidate)
            entry["cluster_id"] = int(labels[i])
            clustered_candidates.append(entry)

        # Write results
        output_path = os.path.join(output_dir, "cluster_results.json")
        with open(output_path, "w") as f:
            json.dump({
                "mode": "cluster",
                "n_clusters": n_clusters,
                "feature_keys": feature_keys,
                "candidates": clustered_candidates,
            }, f, indent=2)

        return self.build_result(
            status="success",
            output_files=[output_path],
            metrics={
                "mode": "cluster",
                "n_clusters": n_clusters,
                "num_candidates": len(clustered_candidates),
            },
        )

    def _execute_rank(
        self, params: dict[str, Any], candidates: list[dict[str, Any]], output_dir: str
    ) -> ToolResult:
        """Rank candidates using Pareto dominance."""
        objectives = params.get("rank_objectives")
        directions = params.get("rank_directions")

        # Auto-set common de novo design objectives if not provided
        if not objectives and candidates:
            # Use common metric keys found in candidate dicts
            MAXIMIZE_KEYS = {"plddt", "avg_plddt", "ptm", "avg_ptm"}
            MINIMIZE_KEYS = {"rmsd_angstrom", "clash_score", "aggregation_propensity"}
            auto_objectives: list[str] = []
            auto_directions: list[str] = []
            for k in candidates[0]:
                if k in MAXIMIZE_KEYS:
                    auto_objectives.append(k)
                    auto_directions.append("maximize")
                elif k in MINIMIZE_KEYS:
                    auto_objectives.append(k)
                    auto_directions.append("minimize")
            if auto_objectives:
                objectives = auto_objectives
                directions = auto_directions
                logger.info("Auto-detected rank objectives: %s", list(zip(objectives, directions)))

        if not objectives or not directions:
            return self.build_error_result(
                "No rank_objectives/rank_directions provided and none auto-detected"
            )
        if len(directions) != len(objectives):
            return self.build_error_result(
                f"rank_directions length ({len(directions)}) must match "
                f"rank_objectives length ({len(objectives)})"
            )

        # Pareto ranking: assign front number to each candidate
        remaining = list(range(len(candidates)))
        ranked_candidates = [dict(c) for c in candidates]
        front_number = 0

        while remaining:
            front_number += 1
            non_dominated = _find_non_dominated(
                [candidates[i] for i in remaining], objectives, directions
            )
            # Map back to original indices
            non_dom_indices = [remaining[i] for i in non_dominated]
            for idx in non_dom_indices:
                ranked_candidates[idx]["pareto_front"] = front_number
            remaining = [i for i in remaining if i not in non_dom_indices]

        # Sort by front number (lower = better), then by first objective as tiebreaker
        sorted_candidates = sorted(
            ranked_candidates,
            key=lambda c: (
                c.get("pareto_front", 999),
                _objective_sort_value(c, objectives[0], directions[0]),
            ),
        )

        # Assign rank
        for rank, candidate in enumerate(sorted_candidates, start=1):
            candidate["rank"] = rank

        # Write results
        output_path = os.path.join(output_dir, "rank_results.json")
        with open(output_path, "w") as f:
            json.dump({
                "mode": "rank",
                "objectives": objectives,
                "directions": directions,
                "candidates": sorted_candidates,
            }, f, indent=2)

        return self.build_result(
            status="success",
            output_files=[output_path],
            metrics={
                "mode": "rank",
                "num_candidates": len(sorted_candidates),
                "num_pareto_fronts": front_number,
            },
        )


def _find_non_dominated(
    candidates: list[dict[str, Any]],
    objectives: list[str],
    directions: list[str],
) -> list[int]:
    """Find non-dominated (Pareto-optimal) candidate indices."""
    n = len(candidates)
    is_dominated = [False] * n

    for i in range(n):
        if is_dominated[i]:
            continue
        for j in range(n):
            if i == j or is_dominated[j]:
                continue
            if _dominates(candidates[j], candidates[i], objectives, directions):
                is_dominated[i] = True
                break

    return [i for i in range(n) if not is_dominated[i]]


def _dominates(
    a: dict[str, Any],
    b: dict[str, Any],
    objectives: list[str],
    directions: list[str],
) -> bool:
    """Check if candidate a dominates candidate b."""
    at_least_one_better = False
    for obj, direction in zip(objectives, directions):
        val_a = float(a.get(obj, 0))
        val_b = float(b.get(obj, 0))
        if direction == "maximize":
            if val_a < val_b:
                return False
            if val_a > val_b:
                at_least_one_better = True
        else:  # minimize
            if val_a > val_b:
                return False
            if val_a < val_b:
                at_least_one_better = True
    return at_least_one_better


def _objective_sort_value(candidate: dict[str, Any], objective: str, direction: str) -> float:
    """Get sort value for a candidate on an objective (negate for maximize)."""
    val = float(candidate.get(objective, 0))
    return -val if direction == "maximize" else val


def create_adapter() -> CandidateOpsAdapter:
    """Factory function to create adapter instance."""
    return CandidateOpsAdapter()
