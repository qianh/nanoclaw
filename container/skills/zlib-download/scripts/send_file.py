#!/usr/bin/env python3
"""
Send a file to the current chat via NanoClaw IPC.
Usage: python3 send_file.py <fileUrl> <filename> [fileType]
  fileType: 1=image, 2=video, 3=voice, 4=file (default)
"""
import json
import os
import pathlib
import sys
import time

def main():
    if len(sys.argv) < 3:
        print("Usage: send_file.py <fileUrl> <filename> [fileType]", file=sys.stderr)
        sys.exit(1)

    file_url = sys.argv[1]
    filename = sys.argv[2]
    file_type = int(sys.argv[3]) if len(sys.argv) > 3 else 4

    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")
    if not chat_jid:
        print("Error: NANOCLAW_CHAT_JID not set", file=sys.stderr)
        sys.exit(1)

    ipc_dir = pathlib.Path("/workspace/ipc/messages")
    ipc_dir.mkdir(parents=True, exist_ok=True)

    msg = {
        "type": "send_file",
        "chatJid": chat_jid,
        "fileUrl": file_url,
        "filename": filename,
        "fileType": file_type,
    }

    ipc_file = ipc_dir / f"{int(time.time() * 1000)}.json"
    ipc_file.write_text(json.dumps(msg))
    print(json.dumps({"status": "ok", "ipc_file": str(ipc_file), "chatJid": chat_jid}))

if __name__ == "__main__":
    main()
