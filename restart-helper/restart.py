import json
import os
import subprocess
import time
from pathlib import Path

ROOT = Path("/signals")
REQUEST = ROOT / "restart-foundry.request"
RESULT = ROOT / "restart-foundry.result"

ROOT.mkdir(parents=True, exist_ok=True)
os.chown(ROOT, 1000, 1000)
os.chmod(ROOT, 0o770)

while True:
    try:
        if REQUEST.exists():
            # Consume atomically before invoking Docker. Never retry the same request.
            claimed = ROOT / "restart-foundry.processing"
            REQUEST.rename(claimed)
            data = json.loads(claimed.read_text())
            claimed.unlink(missing_ok=True)
            if not isinstance(data.get("id"), str) or len(data["id"]) != 32:
                raise ValueError("Invalid restart request")
            if abs(time.time() - float(data.get("at", 0))) > 120:
                raise ValueError("Stale restart request")
            matches = subprocess.run(
                ["docker", "ps", "-q", "--filter", "label=com.docker.compose.project=millwright",
                 "--filter", "label=com.docker.compose.service=foundry"],
                capture_output=True, text=True, timeout=10, check=True
            ).stdout.splitlines()
            if len(matches) != 1:
                raise RuntimeError("Expected exactly one running Millwright Foundry container")
            result = subprocess.run(["docker", "restart", "--time", "30", matches[0]],
                                    capture_output=True, text=True, timeout=100)
            payload = {"id": data["id"], "ok": result.returncode == 0,
                       "message": "Restart command completed" if result.returncode == 0 else "Docker restart failed"}
            RESULT.write_text(json.dumps(payload))
    except Exception as error:
        # Never write raw command output, secrets, or arbitrary request content to the result.
        RESULT.write_text(json.dumps({"id": data.get("id", "") if isinstance(locals().get("data"), dict) else "",
                                      "ok": False, "message": str(error)[:200]}))
    time.sleep(1)
