"""
Encrypt the published payload with AES-256-GCM.

Key derivation is PBKDF2-HMAC-SHA256 at OWASP's current 600,000 iterations. The
envelope records the work factor it was written with, so the cost can be raised
later without invalidating existing ciphertext: the browser honours the number
in the file rather than a number of its own.

There is deliberately **no default passphrase**. A fallback committed to a public
repository is not encryption, it is obfuscation with a key in the drawer — the
previous build of this idea shipped exactly that. A missing passphrase now fails
the run instead of publishing a vault anyone can open.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

DATA_DIR = Path("data")
INPUT_FILE = DATA_DIR / "biometrics.json"
OUTPUT_FILE = DATA_DIR / "biometrics.enc.json"
STATUS_FILE = DATA_DIR / "status.json"

DEFAULT_ITERATIONS = 600_000
ENVELOPE_FORMAT = "aes-256-gcm-pbkdf2"


def encrypt_payload(data_str, password, iterations=DEFAULT_ITERATIONS):
    salt = os.urandom(16)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations
    )
    key = kdf.derive(password.encode("utf-8"))
    iv = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(iv, data_str.encode("utf-8"), None)
    return {
        "format": ENVELOPE_FORMAT,
        "iterations": iterations,
        "salt": base64.b64encode(salt).decode("utf-8"),
        "iv": base64.b64encode(iv).decode("utf-8"),
        "data": base64.b64encode(ciphertext).decode("utf-8"),
    }


def decrypt_payload(envelope, password):
    """Mirror of the browser's path. Used by the tests, never by the site."""
    salt = base64.b64decode(envelope["salt"])
    iv = base64.b64decode(envelope["iv"])
    data = base64.b64decode(envelope["data"])
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=int(envelope["iterations"]),
    )
    key = kdf.derive(password.encode("utf-8"))
    return AESGCM(key).decrypt(iv, data, None).decode("utf-8")


def main():
    if not INPUT_FILE.exists():
        print(f"error: {INPUT_FILE} does not exist. Run sync.py first.")
        sys.exit(1)

    password = os.environ.get("DASHBOARD_PASS")
    if not password:
        print("error: DASHBOARD_PASS is not set. Refusing to publish a vault.")
        print("       Set it as a repository secret (and locally in your shell) —")
        print("       a published passphrase is not encryption.")
        sys.exit(1)

    iterations = int(os.environ.get("DASHBOARD_PBKDF2_ITERATIONS", DEFAULT_ITERATIONS))
    raw_json = INPUT_FILE.read_text(encoding="utf-8")
    envelope = encrypt_payload(raw_json, password, iterations)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(envelope, indent=2), encoding="utf-8")

    payload = json.loads(raw_json)
    STATUS_FILE.write_text(
        json.dumps(
            {
                # Timezone-aware, so a browser cannot read a UTC sync time as local.
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "demo": bool(payload.get("demo")),
                "device": (payload.get("device") or {}).get("name"),
                "metrics_live": (payload.get("data_quality") or {}).get("live_count"),
                "metrics_total": (payload.get("data_quality") or {}).get("total_count"),
                "version": payload.get("schema", 1),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"vault written: {OUTPUT_FILE}")
    print(f"  ciphertext : {len(envelope['data'])} base64 chars")
    print(f"  kdf        : PBKDF2-HMAC-SHA256, {iterations:,} iterations")
    print(f"  status     : {STATUS_FILE} (demo={payload.get('demo')})")


if __name__ == "__main__":
    main()
