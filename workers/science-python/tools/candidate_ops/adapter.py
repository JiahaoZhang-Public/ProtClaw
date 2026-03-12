"""Candidate operations adapter for ProtClaw.

Two modes of operation:
  - "cluster": Sequence clustering using scikit-learn (e.g., k-means on features)
  - "rank": Pareto ranking of candidates by multiple objectives

Input: list of candidate scores/features.
Output: cluster assignments or ranked list.
"""

from __future__ import annotations

import json
import os
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult


class CandidateOpsAdapter(BaseTool):
    """Adapter for candidate clustering and ranking operations."""

    tool_name = "candidate_ops"
    tool_version = "1.0.0"

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

        For mode="cluster":
            feature_keys: list[str] - Keys in candidate dicts to use as features
            n_clusters: int - Number of clusters (default: 5)

        For mode="rank":
            rank_objectives: list[str] - Metric names to rank by
            rank_directions: list[str] - "maximize" or "minimize" per objective
        """
        validated = dict(self.DEFAULTS)
        validated.update(params)

        # Required: mode
        mode = validated.get("mode")
        if mode not in ("cluster", "rank"):
            raise ValueError(f"'mode' must be 'cluster' or 'rank', got: {mode}")
        validated["mode"] = mode

        # Required: candidates
        candidates = validated.get("candidates")
        if not candidates or not isinstance(candidates, list):
            raise ValueError("'candidates' is required and must be a non-empty list of dicts")
        for i, c in enumerate(candidates):
            if not isinstance(c, dict):
                raise ValueError(f"candidates[{i}] must be a dict, got {type(c).__name__}")

        if mode == "cluster":
            feature_keys = validated.get("feature_keys")
            if not feature_keys or not isinstance(feature_keys, list):
                raise ValueError("'feature_keys' is required for cluster mode")
            validated["feature_keys"] = [str(k) for k in feature_keys]

            n_clusters = int(validated["n_clusters"])
            if n_clusters < 1:
                raise ValueError(f"n_clusters must be >= 1, got {n_clusters}")
            if n_clusters > len(candidates):
                raise ValueError(
                    f"n_clusters ({n_clusters}) cannot exceed "
                    f"number of candidates ({len(candidates)})"
                )
            validated["n_clusters"] = n_clusters

        elif mode == "rank":
            objectives = validated.get("rank_objectives")
            if not objectives or not isinstance(objectives, list):
                raise ValueError("'rank_objectives' is required for rank mode")
            validated["rank_objectives"] = [str(o) for o in objectives]

            directions = validated.get("rank_directions")
            if not directions or not isinstance(directions, list):
                raise ValueError("'rank_directions' is required for rank mode")
            if len(directions) != len(objectives):
                raise ValueError(
                    f"rank_directions length ({len(directions)}) must match "
                    f"rank_objectives length ({len(objectives)})"
                )
            for d in directions:
                if d not in ("maximize", "minimize"):
                    raise ValueError(
                        f"rank_directions values must be 'maximize' or 'minimize', got '{d}'"
                    )
            validated["rank_directions"] = [str(d) for d in directions]

        return validated

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute candidate operations (cluster or rank)."""
        mode = params["mode"]
        candidates = params["candidates"]

        if mode == "cluster":
            return self._execute_cluster(params, candidates, output_dir)
        else:
            return self._execute_rank(params, candidates, output_dir)

    def _execute_cluster(
        self, params: dict[str, Any], candidates: list[dict[str, Any]], output_dir: str
    ) -> ToolResult:
        """Cluster candidates by feature similarity using KMeans."""
        feature_keys = params["feature_keys"]
        n_clusters = params["n_clusters"]

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
        objectives = params["rank_objectives"]
        directions = params["rank_directions"]

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
