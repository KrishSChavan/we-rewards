#!/usr/bin/env python3
"""
Mint the Apple "client secret" that Supabase's Apple provider asks for.

WHY THIS EXISTS. Supabase does not build this for you. Its Apple provider has
one Secret Key box, and what belongs in it is a JWT that YOU sign with the .p8
downloaded from the Apple Developer portal. Apple caps the lifetime at six
months, which is why the dashboard warns the secret expires: it is not a
rotating credential Apple issues, it is this token aging out. Re-run this script
and paste the new value when it does.

The signature is ES256 over the Apple-specified claims:
  header.kid = the Key ID (the XXXXXXXXXX in AuthKey_XXXXXXXXXX.p8)
  iss        = your 10-character Team ID
  sub        = the SERVICES ID (com.werewards.app.signin), never the bundle ID.
               The bundle ID only appears here for native ASAuthorization, which
               this app does not use: it signs in through the web flow inside the
               webview (see capacitor.config.json allowNavigation).
  aud        = https://appleid.apple.com

The one real trap: ECDSA signing produces a DER-encoded (r, s) pair, and JWS
wants the two integers raw and fixed-width, concatenated. Handing Apple the DER
bytes yields an "invalid_client" that looks exactly like a wrong key.

Usage:
    python3 scripts/apple-client-secret.py <TEAM_ID> [path/to/AuthKey_*.p8]

Writes the token to apple-client-secret.txt beside the key and prints nothing
secret, so the value does not end up in shell history or a terminal transcript.
"""

import json
import os
import re
import sys
import time
from base64 import urlsafe_b64encode

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

SERVICES_ID = 'com.werewards.app.signin'
SIX_MONTHS = 15777000          # Apple's hard ceiling, in seconds


def b64(raw: bytes) -> str:
    """base64url with the padding stripped, as JWS requires."""
    return urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 2

    team_id = sys.argv[1].strip()
    if not re.fullmatch(r'[A-Z0-9]{10}', team_id):
        print(f'Team ID looks wrong: {team_id!r}. Expected 10 characters, A-Z and 0-9.')
        return 2

    key_path = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser(
        '~/Downloads/AuthKey_KXS8VLW855.p8')
    if not os.path.exists(key_path):
        print(f'No key at {key_path}')
        return 2

    m = re.search(r'AuthKey_([A-Z0-9]+)\.p8$', os.path.basename(key_path))
    if not m:
        print('Key filename is not AuthKey_<KEYID>.p8, so the Key ID cannot be read from it.')
        return 2
    key_id = m.group(1)

    with open(key_path, 'rb') as fh:
        key = serialization.load_pem_private_key(fh.read(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        print('That .p8 is not an EC key, so it is not an Apple auth key.')
        return 2

    now = int(time.time())
    header = {'alg': 'ES256', 'kid': key_id}
    payload = {
        'iss': team_id,
        'iat': now,
        'exp': now + SIX_MONTHS,
        'aud': 'https://appleid.apple.com',
        'sub': SERVICES_ID,
    }

    signing_input = '.'.join((
        b64(json.dumps(header, separators=(',', ':')).encode()),
        b64(json.dumps(payload, separators=(',', ':')).encode()),
    )).encode('ascii')

    der = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, 'big') + s.to_bytes(32, 'big')   # DER -> raw, see docstring

    token = signing_input.decode('ascii') + '.' + b64(raw)

    out = os.path.join(os.path.dirname(os.path.abspath(key_path)),
                       'apple-client-secret.txt')
    with open(out, 'w') as fh:
        fh.write(token + '\n')
    os.chmod(out, 0o600)

    expires = time.strftime('%Y-%m-%d', time.localtime(now + SIX_MONTHS))
    print(f'Key ID      {key_id}')
    print(f'Team ID     {team_id}')
    print(f'Services ID {SERVICES_ID}')
    print(f'Expires     {expires}  (regenerate before this date)')
    print(f'Written to  {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
