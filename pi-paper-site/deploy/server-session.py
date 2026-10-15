"""One SSH session; password stays in memory and is read without echo."""
import base64
import getpass
import hashlib
import json
import shlex
import sys
from pathlib import Path

import paramiko

host = sys.argv[1]
transport = paramiko.Transport((host, 22))
transport.start_client(timeout=15)
key = transport.get_remote_server_key()
fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
if len(sys.argv) > 2 and fingerprint != sys.argv[2]:
    transport.close()
    raise RuntimeError('SSH host key does not match the supplied fingerprint')
print('SSH host key: ' + fingerprint, flush=True)
password = getpass.getpass('SSH password (hidden): ')
transport.auth_password('root', password)
password = None
print('Connected. Ready for JSON operations.', flush=True)
sftp = paramiko.SFTPClient.from_transport(transport)

def run(command):
    channel = transport.open_session()
    channel.exec_command(command)
    output = channel.makefile('rb').read().decode('utf-8', errors='replace')
    error = channel.makefile_stderr('rb').read().decode('utf-8', errors='replace')
    code = channel.recv_exit_status()
    print(json.dumps({'exit': code, 'stdout': output, 'stderr': error}, ensure_ascii=False), flush=True)
    return code

try:
    for line in sys.stdin:
        request = json.loads(line)
        if request['op'] == 'quit':
            break
        if request['op'] == 'exec':
            run(request['command'])
        elif request['op'] == 'upload':
            source = Path(request['source']).resolve(strict=True)
            target = request['target']
            if not target.startswith('/var/www/pi-paper/'):
                raise ValueError('Upload target must stay inside /var/www/pi-paper/')
            files = [source] if source.is_file() else [p for p in source.rglob('*') if p.is_file()]
            for file in files:
                relative = file.name if source.is_file() else file.relative_to(source).as_posix()
                remote = target.rstrip('/') + '/' + relative
                run('mkdir -p -- ' + shlex.quote(remote.rsplit('/', 1)[0]))
                sftp.put(str(file), remote)
            print(json.dumps({'uploaded': len(files), 'target': target}), flush=True)
finally:
    sftp.close()
    transport.close()
