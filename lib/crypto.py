"""
Application-level credential encryption using Fernet (AES-128-CBC + HMAC).

Set CREDENTIALS_ENCRYPTION_KEY in .env to a Fernet key:
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Both encrypt_credentials() and decrypt_credentials() raise RuntimeError if
encryption is unavailable for any reason (missing package or missing key).
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


def _get_fernet() -> "Fernet":
    if not _FERNET_AVAILABLE:
        raise RuntimeError(
            "cryptography package is not installed — cannot encrypt or decrypt credentials. "
            "Run: pip install cryptography"
        )
    key = os.environ.get("CREDENTIALS_ENCRYPTION_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "CREDENTIALS_ENCRYPTION_KEY is not set — refusing to store credentials unencrypted. "
            "Generate a key with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    return Fernet(key.encode())


def encrypt_credentials(creds: dict) -> dict:
    """Return {"_enc": ciphertext}. Raises RuntimeError if encryption is unavailable."""
    ciphertext = _get_fernet().encrypt(json.dumps(creds).encode()).decode()
    return {"_enc": ciphertext}


def decrypt_credentials(stored: dict) -> dict:
    """Decrypt an encrypted credentials dict; pass-through for legacy plaintext rows."""
    if "_enc" not in stored:
        return stored
    plaintext = _get_fernet().decrypt(stored["_enc"].encode())
    return json.loads(plaintext)
