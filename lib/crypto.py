"""
Application-level credential encryption using Fernet (AES-128-CBC + HMAC).

Set CREDENTIALS_ENCRYPTION_KEY in .env to a Fernet key:
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

If the key is absent, encrypt_credentials() stores plaintext (logs a warning).
decrypt_credentials() transparently handles both encrypted and legacy plaintext rows.
"""

import json
import logging
import os

log = logging.getLogger(__name__)

try:
    from cryptography.fernet import Fernet, InvalidToken
    _FERNET_AVAILABLE = True
except ImportError:
    _FERNET_AVAILABLE = False
    log.warning("cryptography package not installed — credential encryption disabled")


def _get_fernet():
    if not _FERNET_AVAILABLE:
        return None
    key = os.environ.get("CREDENTIALS_ENCRYPTION_KEY", "").strip()
    if not key:
        return None
    return Fernet(key.encode())


def encrypt_credentials(creds: dict) -> dict:
    """Return {"_enc": ciphertext} if a key is configured, else creds unchanged."""
    f = _get_fernet()
    if f is None:
        log.warning("CREDENTIALS_ENCRYPTION_KEY not set — storing credentials unencrypted")
        return creds
    ciphertext = f.encrypt(json.dumps(creds).encode()).decode()
    return {"_enc": ciphertext}


def decrypt_credentials(stored: dict) -> dict:
    """Decrypt an encrypted credentials dict; pass-through for legacy plaintext rows."""
    if "_enc" not in stored:
        return stored
    f = _get_fernet()
    if f is None:
        raise RuntimeError(
            "CREDENTIALS_ENCRYPTION_KEY not set but encrypted credentials were found. "
            "Set the key to match the one used when credentials were stored."
        )
    plaintext = f.decrypt(stored["_enc"].encode())
    return json.loads(plaintext)
