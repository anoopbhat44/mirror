"""Optional user config for the Mirror plugin: ~/.mirror/config.json.

All keys are optional; defaults apply when the file or a key is missing. The bind
host is intentionally not configurable to a non-loopback address (privacy
principle): Mirror stays on 127.0.0.1.
"""

import json
import os

import state

CONFIG_PATH = os.path.join(state.STATE_DIR, "config.json")

DEFAULTS = {
    "port": state.DEFAULT_PORT,   # preferred start port (launcher still finds a free one)
    "theme": "dark",              # default client theme: "dark" or "light"
    "auto_open": False,           # open the browser when the server starts
}


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            user = json.load(fh)
        if isinstance(user, dict):
            for key in DEFAULTS:
                if key in user:
                    cfg[key] = user[key]
    except (OSError, ValueError):
        pass
    if cfg.get("theme") not in ("dark", "light"):
        cfg["theme"] = "dark"
    return cfg
