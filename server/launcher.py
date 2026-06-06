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
    configured = cfg.get("port", state.DEFAULT_PORT)

    # Reuse a healthy mirror if one is already listening. Anchor on the
    # configured port, not only the active.json pointer, so a missing or stale
    # pointer can't make a second session spawn a duplicate server on the next
    # port. Prefer whatever the pointer names (it may run on a non-default port),
    # then the configured port.
    prev = state.read_active()
    active_port = prev.get("port") if prev else None
    port = None
    for candidate in (active_port, configured):
        if candidate and state.is_mirror_running(candidate):
            port = candidate
            break

    if port is None:
        port = _start_server(configured, cfg)

    state.write_active(transcript_path, session_id, port)
    return port


def _start_server(configured, cfg):
    """Bring a server up and return the port it answers on. Prefer the configured
    port so every session converges on one server. If that port is busy because a
    mirror already grabbed it (a concurrent-start race), reuse it; only move to a
    different port when something that is not Mirror holds the configured one."""
    if state._port_is_free(configured):
        target = configured
    elif state.is_mirror_running(configured):
        return configured  # another session already started our server there
    else:
        target = state.find_free_port(configured)

    _spawn_server(target)
    for _ in range(40):  # up to ~4s for the server to answer /healthz
        if state.is_mirror_running(target):
            if cfg.get("auto_open"):
                _open_browser("http://localhost:%d" % target)
            return target
        time.sleep(0.1)

    # Our spawn never answered (it may have lost a bind race). If a mirror came
    # up on the configured port meanwhile, converge on it rather than report a
    # dead port.
    if state.is_mirror_running(configured):
        return configured
    return target
