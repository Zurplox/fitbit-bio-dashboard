"""
One-time OAuth consent, to obtain the refresh token the sync needs.

Run this once on your own machine, in a browser you are already signed into:

    python scripts/authorize.py

It opens Google's consent screen, catches the redirect on a loopback port, and
prints the refresh token. Nothing is written to disk unless you pass --save.

Prerequisites, in the Google Cloud console for the project that has the Google
Health API enabled:

  * OAuth client type: Web application
  * Authorized redirect URI: http://127.0.0.1:8765/   (add this exact string)
  * Test users: your own Google account, while the app is in Testing mode

Then set the three values as repository secrets / environment variables:
GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, GOOGLE_HEALTH_REFRESH_TOKEN.

Note on Testing mode: Google expires refresh tokens after 7 days while the
consent screen is unpublished. Publish the app (or repeat this script weekly).
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from googlehealth_source import SCOPES, TOKEN_URL  # noqa: E402

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
REDIRECT_URI = "http://127.0.0.1:8765/"
PORT = 8765

captured = {}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's API
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        captured.update({key: values[0] for key, values in params.items()})
        body = (
            b"<html><body style='font-family:system-ui;padding:48px;background:#0a0d12;color:#e9eff6'>"
            b"<h2>Authorisation received</h2><p>You can close this tab and return to the terminal.</p>"
            b"</body></html>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def auth_url(client_id, state):
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return AUTH_URL + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def exchange(client_id, client_secret, code):
    body = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": REDIRECT_URI,
        }
    ).encode()
    request = urllib.request.Request(
        TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def manual_code(url, state):
    """Let the user paste the whole redirected URL when loopback is unavailable."""
    print("\nOpen this URL, approve access, then copy the address it redirects to:")
    print("\n  " + url + "\n")
    pasted = input("Paste the full redirect URL here: ").strip()
    query = urllib.parse.urlparse(pasted).query or pasted
    params = urllib.parse.parse_qs(query)
    if params.get("state", [None])[0] not in (None, state):
        raise SystemExit("State mismatch. Re-run and use the URL this script printed.")
    if "error" in params:
        raise SystemExit(f"Google refused: {params['error'][0]}")
    code = params.get("code", [None])[0]
    if not code:
        raise SystemExit("No code in that URL.")
    return code


def main():
    parser = argparse.ArgumentParser(description="Obtain a Google Health API refresh token.")
    parser.add_argument("--manual", action="store_true", help="paste the redirect URL instead of using loopback")
    parser.add_argument("--save", metavar="PATH", help="also write the token JSON to this path")
    args = parser.parse_args()

    client_id = os.environ.get("GOOGLE_HEALTH_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_HEALTH_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise SystemExit(
            "Set GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET first "
            "(Google Cloud console → APIs & Services → Credentials)."
        )

    state = secrets.token_urlsafe(16)
    url = auth_url(client_id, state)

    if args.manual:
        code = manual_code(url, state)
    else:
        print(f"\nListening on {REDIRECT_URI}")
        print("Opening the consent screen. If nothing opens, visit:\n\n  " + url + "\n")
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001 - a headless machine still works manually
            pass
        server = HTTPServer(("127.0.0.1", PORT), Handler)
        server.handle_request()
        if "error" in captured:
            raise SystemExit(f"Google refused: {captured['error']}")
        if captured.get("state") != state:
            raise SystemExit("State mismatch — possible tampering. Nothing was saved.")
        code = captured.get("code")
        if not code:
            raise SystemExit("No authorisation code was returned.")

    tokens = exchange(client_id, client_secret, code)
    refresh = tokens.get("refresh_token")
    if not refresh:
        raise SystemExit(
            "No refresh_token in the response. Re-run with prompt=consent (this script already "
            "sets it) and make sure the app has offline access."
        )

    print("\nSuccess. Add these as repository secrets:")
    print(f"  GOOGLE_HEALTH_CLIENT_ID={client_id}")
    print("  GOOGLE_HEALTH_CLIENT_SECRET=<unchanged>")
    print(f"  GOOGLE_HEALTH_REFRESH_TOKEN={refresh}")

    if args.save:
        with open(args.save, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "client_id": client_id,
                    "refresh_token": refresh,
                    "scopes": SCOPES,
                },
                handle,
                indent=2,
            )
        print(f"\nWritten to {args.save} — keep it out of version control.")


if __name__ == "__main__":
    main()
