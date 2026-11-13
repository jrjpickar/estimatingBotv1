"""Start the sandbox on loopback with no deployment configuration."""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--temporary-storage", action="store_true",
                        help="Use an isolated database and discard it when the server stops.")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if not (root / "dist/index.html").is_file():
        parser.exit(1, "Run npm ci and npm run build before npm start.\n")

    from .main import DATA, app, initialize_storage

    if args.temporary_storage:
        with TemporaryDirectory(prefix="a2z-takeoff-") as temporary:
            initialize_storage(temporary)
            uvicorn.run(app, host="127.0.0.1", port=8765)
    else:
        initialize_storage(DATA)
        uvicorn.run(app, host="127.0.0.1", port=8765)


if __name__ == "__main__":
    main()
