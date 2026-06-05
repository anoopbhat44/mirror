"""Start-or-reuse the Mirror server and point it at the active transcript.

Both hooks call ``ensure_running``. It reuses a healthy server if one is already
listening on the recorded port, otherwise it picks a free port and spawns the
server detached so it outlives the hook process.
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import state  # noqa: E402
import config  # noqa: E402

SERVER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mirror_server.py")


def _open_browser(url):
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    try:
        subprocess.Popen([opener, url], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    except OSError:
        pass


def _spawn_server(port):
    state.ensure_state_dir()
    log = open(state.LOG_PATH, "ab")
    subprocess.Popen(
        [sys.executable, SERVER_PATH, "--port", str(port)],
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        start_new_session=True,  # detach: survives the hook exiting
        close_fds=True,
        cwd=os.path.dirname(SERVER_PATH),
    )


def ensure_running(transcript_path, session_id):
    cfg = config.load()
    prev = state.read_active()
    port = None
    if prev and prev.get("port") and state.is_mirror_running(prev["port"]):
        port = prev["port"]

    if port is None:
        port = state.find_free_port(cfg.get("port", state.DEFAULT_PORT))
        _spawn_server(port)
        started = False
        for _ in range(40):  # up to ~4s for the server to answer /healthz
            if state.is_mirror_running(port):
                started = True
                break
            time.sleep(0.1)
        if started and cfg.get("auto_open"):
            _open_browser("http://localhost:%d" % port)

    state.write_active(transcript_path, session_id, port)
    return port
