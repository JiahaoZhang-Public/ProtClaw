"""RFdiffusion adapter for ProtClaw.

Wraps the RFdiffusion CLI for protein backbone generation via diffusion.
Input: contig specification, number of designs, noise parameters.
Output: PDB files of generated backbones in output_dir.
"""

from __future__ import annotations

import glob
import logging
import os
import subprocess
import sys
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult

logger = logging.getLogger(__name__)


class RFdiffusionAdapter(BaseTool):
    """Adapter for RFdiffusion protein backbone generation."""

    tool_name = "rfdiffusion"
    tool_version = "1.1.0"

    # Default parameter values
    DEFAULTS: dict[str, Any] = {
        "num_designs": 1,
        "noise_scale": 1.0,
        "partial_T": None,
        "model_checkpoint": None,
    }

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate RFdiffusion input parameters.

        Required:
            contigs: str - Contig specification (e.g., "100-100" for 100-residue chain)

        Optional:
            num_designs: int - Number of designs to generate (default: 1)
            noise_scale: float - Noise scale for diffusion (default: 1.0)
            partial_T: int | None - Partial diffusion timesteps
            model_checkpoint: str | None - Path to model weights
        """
        validated = dict(self.DEFAULTS)
        validated.update(params)

        # Required: contigs
        if "contigs" not in validated or not validated["contigs"]:
            raise ValueError("'contigs' is required (e.g., '100-100' for 100-residue chain)")

        contigs = str(validated["contigs"])
        validated["contigs"] = contigs

        # Validate num_designs
        num_designs = int(validated["num_designs"])
        if num_designs < 1 or num_designs > 1000:
            raise ValueError(f"num_designs must be between 1 and 1000, got {num_designs}")
        validated["num_designs"] = num_designs

        # Validate noise_scale
        noise_scale = float(validated["noise_scale"])
        if noise_scale < 0.0:
            raise ValueError(f"noise_scale must be non-negative, got {noise_scale}")
        validated["noise_scale"] = noise_scale

        # Validate partial_T if provided
        if validated["partial_T"] is not None:
            partial_t = int(validated["partial_T"])
            if partial_t < 1:
                raise ValueError(f"partial_T must be positive, got {partial_t}")
            validated["partial_T"] = partial_t

        return validated

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute RFdiffusion backbone generation.

        Calls the RFdiffusion inference script via subprocess and collects
        generated PDB files from the output directory.
        """
        contigs = params["contigs"]
        num_designs = params["num_designs"]
        noise_scale = params["noise_scale"]

        rfdiffusion_dir = os.environ.get("RFDIFFUSION_DIR", "/root/repos/RFdiffusion")
        model_dir = os.environ.get("RFDIFFUSION_WEIGHTS", "/root/autodl-tmp/models/rfdiffusion")

        # Build the RFdiffusion CLI command
        inference_script = os.path.join(rfdiffusion_dir, "scripts", "run_inference.py")
        if not os.path.isfile(inference_script):
            return self.build_error_result(
                f"RFdiffusion inference script not found: {inference_script}. "
                f"Is RFDIFFUSION_DIR set correctly?"
            )

        output_prefix = os.path.join(output_dir, "design")

        cmd = [
            sys.executable,
            inference_script,
            f"inference.output_prefix={output_prefix}",
            f"contigmap.contigs=[{contigs}]",
            f"inference.num_designs={num_designs}",
            f"denoiser.noise_scale_ca={noise_scale}",
            f"denoiser.noise_scale_frame={noise_scale}",
            f"inference.model_directory_path={model_dir}",
        ]

        # Optional: partial_T for partial diffusion
        if params.get("partial_T"):
            cmd.append(f"diffuser.partial_T={params['partial_T']}")

        # Optional: input PDB for scaffolded generation
        input_pdbs = glob.glob(os.path.join(input_dir, "*.pdb"))
        if input_pdbs:
            cmd.append(f"inference.input_pdb={input_pdbs[0]}")

        # Optional: model checkpoint override
        if params.get("model_checkpoint"):
            cmd.append(f"inference.ckpt_override_path={params['model_checkpoint']}")

        logger.info("Running RFdiffusion: %s", " ".join(cmd))

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=3600,
                cwd=rfdiffusion_dir,
            )
        except subprocess.TimeoutExpired:
            return self.build_error_result(
                "RFdiffusion timed out after 3600 seconds"
            )
        except FileNotFoundError as e:
            return self.build_error_result(f"Failed to run RFdiffusion: {e}")

        if result.returncode != 0:
            error_tail = result.stderr[-2000:] if result.stderr else "No stderr"
            return self.build_error_result(
                f"RFdiffusion failed (exit {result.returncode}):\n{error_tail}"
            )

        # Collect output PDB files
        output_files = sorted(glob.glob(os.path.join(output_dir, "design_*.pdb")))

        if not output_files:
            # Some RFdiffusion versions use different naming
            output_files = sorted(glob.glob(os.path.join(output_dir, "*.pdb")))

        if not output_files:
            return self.build_error_result(
                "RFdiffusion completed but no PDB files found in output directory. "
                f"stdout: {result.stdout[-500:]}"
            )

        logger.info("RFdiffusion generated %d PDB files", len(output_files))

        return self.build_result(
            status="success",
            output_files=output_files,
            metrics={
                "num_designs_generated": len(output_files),
                "contigs": contigs,
                "noise_scale": noise_scale,
            },
        )


def create_adapter() -> RFdiffusionAdapter:
    """Factory function to create adapter instance."""
    return RFdiffusionAdapter()
