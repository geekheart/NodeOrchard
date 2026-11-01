"""Prepare a private native Hermes profile without changing the source profile."""
import json
import os
from pathlib import Path
import sys

try:
    import hermes_yaml as yaml
except ModuleNotFoundError as error:
    if error.name != "hermes_yaml":
        raise
    import yaml
from dotenv import dotenv_values


def policy_environment_key(name):
    key = name.upper()
    return (
        key in {
            "HOME", "PATH", "TMPDIR", "TEMP", "TMP", "VIRTUAL_ENV",
            "HERMES_HOME", "HERMES_BASE_HOME", "HERMES_PROFILE", "HERMES_RUNTIME_DIR",
            "HERMES_PYTHON_SRC_ROOT", "HERMES_BUNDLED_PLUGINS", "HERMES_ENABLE_PROJECT_PLUGINS",
            "HERMES_YOLO_MODE", "HERMES_DISABLE_LAZY_INSTALLS", "HERMES_ALLOW_INSECURE_TLS",
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY",
            "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
        }
        or key.startswith(("TERMINAL_", "WORKBENCH_", "PYTHON", "NODE_", "XDG_", "LD_", "DYLD_", "BASH_", "UV_", "HERMES_TUI_", "HERMES_BOOTSTRAP_"))
        or key.endswith("_PROXY")
    )


def prepare(path, skills, work):
    config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(config, dict):
        raise ValueError("Hermes config must be a mapping")
    # Local subprocesses remain inside the inherited OS sandbox. Neither source
    # YAML nor dotenv may redirect terminal execution into Docker/SSH/Modal.
    terminal = config.get("terminal") or {}
    if not isinstance(terminal, dict):
        raise ValueError("Hermes terminal config must be a mapping")
    terminal.update({"backend": "local", "cwd": str(work)})
    config["terminal"] = terminal
    skill_config = config.get("skills") or {}
    if not isinstance(skill_config, dict):
        raise ValueError("Hermes skills config must be a mapping")
    skill_config["external_dirs"] = [str(skills)]
    config["skills"] = skill_config
    config.setdefault("agent", {})
    path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
    os.chmod(path, 0o600)
    dotenv = path.parent / ".env"
    if dotenv.exists():
        # Parse real dotenv syntax, including multiline quoted values. Filtering
        # raw lines could leave a removed variable's continuation in the file.
        values = dotenv_values(dotenv, interpolate=False)
        safe = {key: value for key, value in values.items() if isinstance(value, str) and not policy_environment_key(key)}
        dotenv.write_text("".join(key + "=" + json.dumps(value, ensure_ascii=False) + "\n" for key, value in safe.items()), encoding="utf-8")
        os.chmod(dotenv, 0o600)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise ValueError("Expected private config, skill snapshot and workspace paths")
    prepare(*map(Path, sys.argv[1:]))
