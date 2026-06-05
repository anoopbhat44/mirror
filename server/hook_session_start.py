"""SessionStart hook: ensure the Mirror server is up, then show the user the link.

Reads the hook payload on stdin, starts/reuses the server, and prints JSON with a
``systemMessage`` (shown in the terminal) plus ``additionalContext`` (so the model
can also mention the link).
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from launcher import ensure_running  # noqa: E402


def mirror_context(url):
    """The additionalContext injected at session start.

    Beyond pointing the model at the live view, it steers diagram output toward
    fenced ``mermaid`` blocks. Mirror renders those as real diagrams at no extra
    cost; ASCII art still shows fine but is never upgraded. This is a one-line
    formatting preference, not a behavior change, and rides the normal session.
    """
    return (
        "A live HTML mirror of this conversation is available at %s "
        "(localhost only). Mention this link to the user. "
        "When you would draw a diagram (flowchart, sequence, architecture, "
        "state, class, or ER), output it as a fenced ```mermaid code block "
        "rather than ASCII art: Mirror renders mermaid as a real diagram in "
        "that view. Plain ASCII still displays fine." % url
    )


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        payload = {}

    transcript_path = payload.get("transcript_path")
    session_id = payload.get("session_id")

    try:
        port = ensure_running(transcript_path, session_id)
    except Exception as exc:  # never break the session over a viewer
        print(json.dumps({"systemMessage": "Mirror could not start: %s" % exc}))
        return

    url = "http://localhost:%d" % port
    print(
        json.dumps(
            {
                "systemMessage": "\U0001FA9E Mirror live view: %s" % url,
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": mirror_context(url),
                },
            }
        )
    )


if __name__ == "__main__":
    main()
