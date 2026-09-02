#!/opt/homebrew/opt/omlx/libexec/bin/python3.11
"""Apply a panic-safe MBP oMLX profile without touching auth secrets."""

from __future__ import annotations

import json
import shutil
import subprocess
from argparse import ArgumentParser
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from omlx.model_settings import ModelSettingsManager
from omlx.settings import GlobalSettings


BASE_PATH = Path.home() / ".omlx"
MODEL_ID = "Qwen3.8-Flash-Next-oQ4e-mtp"


@dataclass(frozen=True)
class Profile:
    name: str
    memory_guard_tier: str
    hard_threshold: float
    context: int
    max_output: int
    concurrency: int
    hot_cache: str
    initial_cache_blocks: int
    ple_ssd_offload: bool


PROFILES = {
    "safe-offload": Profile(
        name="safe-offload",
        memory_guard_tier="safe",
        hard_threshold=0.95,
        context=65_536,
        max_output=16_384,
        concurrency=2,
        hot_cache="16GB",
        initial_cache_blocks=256,
        ple_ssd_offload=True,
    ),
    "max-resident": Profile(
        name="max-resident",
        memory_guard_tier="aggressive",
        hard_threshold=0.98,
        context=65_536,
        max_output=16_384,
        concurrency=1,
        hot_cache="0GB",
        initial_cache_blocks=64,
        ple_ssd_offload=False,
    ),
}


def require_default_metal_limit() -> None:
    result = subprocess.run(
        ["/usr/sbin/sysctl", "-n", "iogpu.wired_limit_mb"],
        check=True,
        capture_output=True,
        text=True,
    )
    if result.stdout.strip() != "0":
        raise SystemExit(
            "Refusing to configure oMLX while iogpu.wired_limit_mb is non-zero"
        )


def backup_settings(profile: Profile) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BASE_PATH / "backups" / f"pre-{profile.name}-{stamp}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    for name in ("settings.json", "model_settings.json"):
        source = BASE_PATH / name
        if source.exists():
            shutil.copy2(source, backup_dir / name)
    return backup_dir


def configure_global_settings(profile: Profile) -> None:
    settings = GlobalSettings.load(BASE_PATH)
    settings.server.burst_decode_mode = "balanced"
    settings.memory.prefill_memory_guard = True
    settings.memory.memory_guard_tier = profile.memory_guard_tier
    settings.memory.memory_guard_custom_ceiling_gb = 0.0
    settings.memory.soft_threshold = 0.85
    settings.memory.hard_threshold = profile.hard_threshold
    settings.memory.prefill_safe_zone_ratio = 0.80
    settings.memory.prefill_min_chunk_tokens = 32
    settings.scheduler.max_concurrent_requests = profile.concurrency
    settings.scheduler.chunked_prefill = False
    settings.scheduler.prefill_priority = "context"
    settings.cache.enabled = True
    settings.cache.hot_cache_max_size = profile.hot_cache
    settings.cache.initial_cache_blocks = profile.initial_cache_blocks
    settings.sampling.max_context_window = profile.context
    settings.sampling.max_context_window_policy = profile.context
    settings.sampling.max_tokens = profile.max_output
    settings.idle_timeout.idle_timeout_seconds = None
    settings.save()


def configure_model_settings(profile: Profile) -> None:
    manager = ModelSettingsManager(BASE_PATH)
    model = manager.get_settings(MODEL_ID)
    model.max_context_window = profile.context
    model.max_tokens = profile.max_output
    model.qwen4_ple_ssd_offload = profile.ple_ssd_offload
    model.mtp_enabled = True
    model.mtp_num_draft_tokens = 3
    model.vlm_mtp_enabled = False
    model.turboquant_kv_enabled = False
    model.is_pinned = False
    model.is_default = True
    manager.set_settings(MODEL_ID, model)


def verify(profile: Profile) -> dict[str, object]:
    settings = GlobalSettings.load(BASE_PATH)
    model = ModelSettingsManager(BASE_PATH).get_settings(MODEL_ID)
    checks = {
        "metal_limit_default": subprocess.check_output(
            ["/usr/sbin/sysctl", "-n", "iogpu.wired_limit_mb"], text=True
        ).strip()
        == "0",
        "memory_guard_tier": (
            settings.memory.memory_guard_tier == profile.memory_guard_tier
        ),
        "hard_threshold": (
            settings.memory.hard_threshold == profile.hard_threshold
        ),
        "bounded_concurrency": (
            settings.scheduler.max_concurrent_requests == profile.concurrency
        ),
        "bounded_context": model.max_context_window == profile.context,
        "bounded_output": model.max_tokens == profile.max_output,
        "ple_mode": model.qwen4_ple_ssd_offload is profile.ple_ssd_offload,
        "hot_cache_budget": settings.cache.hot_cache_max_size == profile.hot_cache,
        "mtp_depth_three": model.mtp_enabled is True
        and model.mtp_num_draft_tokens == 3,
        "not_pinned": model.is_pinned is False,
        "xgrammar_import": subprocess.run(
            [
                "/opt/homebrew/opt/omlx/libexec/bin/python3.11",
                "-c",
                "import xgrammar",
            ],
            capture_output=True,
        ).returncode
        == 0,
    }
    if not all(checks.values()):
        raise SystemExit(f"oMLX safe-profile verification failed: {checks}")
    return checks


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument(
        "--profile", choices=PROFILES, default="safe-offload"
    )
    args = parser.parse_args()
    profile = PROFILES[args.profile]
    require_default_metal_limit()
    backup_dir = backup_settings(profile)
    configure_global_settings(profile)
    configure_model_settings(profile)
    print(
        json.dumps(
            {
                "profile": profile.name,
                "backup": str(backup_dir),
                "checks": verify(profile),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
