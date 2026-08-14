import argparse
import hashlib
import os
from pathlib import Path

import pooch
from rembg import new_session, remove


MODEL_MD5 = {
    "u2netp": "8e83ca70e441ab06c318d82300c84806",
    "u2net": "60024c5c889badc19c04ad937298a77b",
}


def parse_args():
    parser = argparse.ArgumentParser(description="MiaoHui controlled rembg runner")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True, choices=("u2netp", "u2net"))
    parser.add_argument("--alpha-matting", action="store_true")
    parser.add_argument("--foreground-threshold", type=int, default=240)
    parser.add_argument("--background-threshold", type=int, default=10)
    parser.add_argument("--erode-size", type=int, default=10)
    return parser.parse_args()


def main():
    args = parse_args()
    input_path = Path(args.input).resolve(strict=True)
    output_path = Path(args.output).resolve()
    model_directory = Path(os.environ["U2NET_HOME"]).resolve(strict=True)
    model_path = (model_directory / f"{args.model}.onnx").resolve(strict=True)
    if model_path.parent != model_directory:
        raise RuntimeError("Model path escaped the configured model directory")
    digest = hashlib.md5()
    with model_path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != MODEL_MD5[args.model]:
        raise RuntimeError(f"Local {args.model} model checksum is invalid; refusing network download")

    def local_model_only(_url, _known_hash, *, fname, path, **_kwargs):
        requested = (Path(path).resolve() / fname).resolve()
        if requested != model_path:
            raise RuntimeError("rembg requested a model outside the controlled local path")
        return str(model_path)

    # rembg normally asks pooch to download a missing/corrupt model. The desktop
    # app is offline-first, so replace that path with an already-verified file.
    pooch.retrieve = local_model_only
    output_path.parent.mkdir(parents=True, exist_ok=True)
    session = new_session(args.model)
    result = remove(
        input_path.read_bytes(),
        session=session,
        alpha_matting=args.alpha_matting,
        alpha_matting_foreground_threshold=args.foreground_threshold,
        alpha_matting_background_threshold=args.background_threshold,
        alpha_matting_erode_size=args.erode_size,
        force_return_bytes=True,
    )
    output_path.write_bytes(result)


if __name__ == "__main__":
    main()
