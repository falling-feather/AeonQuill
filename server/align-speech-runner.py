"""Offline WhisperX forced alignment runner for AEONQUILL.

The caller supplies the known text. This runner never transcribes the audio and
never downloads a model. It sends one JSON object to stdout and diagnostics to
stderr so the Node adapter can keep the candidate protocol path-free.
"""

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path


MAX_TEXT_LENGTH = 2_000
MAX_LANGUAGE_LENGTH = 32
MAX_WORDS = 8_192
MAX_CPU_THREADS = 4
REQUIRED_MODEL_FILES = (
    "config.json",
    "preprocessor_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "pytorch_model.bin",
)


class RunnerFailure(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise RunnerFailure(code, message)


def controlled_directory(value):
    try:
        path = Path(value).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", f"Configured model directory is unavailable: {exc}")
    if not path.is_dir():
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Configured model directory is not a directory")
    return path


def controlled_input(value):
    try:
        path = Path(value).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", f"Input audio is unavailable: {exc}")
    if not path.is_file():
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", "Input audio is not a file")
    return path


def enable_offline_environment(model_directory, ffmpeg_path):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    nltk_directory = model_directory / "nltk_data"
    os.environ["NLTK_DATA"] = str(nltk_directory)
    ffmpeg_directory = ffmpeg_path.parent
    current_path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join([str(ffmpeg_directory), current_path])


def validate_local_model(model_directory):
    files = []
    for filename in REQUIRED_MODEL_FILES:
        path = (model_directory / filename).resolve()
        if path.parent != model_directory or not path.is_file():
            fail("SPEECH_ALIGNMENT_UNAVAILABLE", f"Local alignment model file is missing: {filename}")
        files.append(path)
    try:
        config = json.loads((model_directory / "config.json").read_text(encoding="utf-8"))
        preprocessor = json.loads((model_directory / "preprocessor_config.json").read_text(encoding="utf-8"))
        vocab = json.loads((model_directory / "vocab.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", f"Local alignment model metadata is invalid: {exc}")
    if not isinstance(config.get("vocab_size"), int) or config["vocab_size"] <= 0:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Local alignment model config has no bounded vocabulary")
    if preprocessor.get("sampling_rate") != 16_000:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Local alignment model must use a 16kHz preprocessor")
    if not isinstance(vocab, dict) or len(vocab) < 10:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Local alignment model vocabulary is missing")
    weight = model_directory / "pytorch_model.bin"
    if weight.stat().st_size < 1_000_000_000:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Local alignment model weight is unexpectedly small")
    punkt_tab = model_directory / "nltk_data" / "tokenizers" / "punkt_tab"
    if not punkt_tab.is_dir():
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Local NLTK punkt_tab resource is missing")
    try:
        from nltk.data import find
        find("tokenizers/punkt_tab")
    except (ImportError, LookupError) as exc:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", f"Local NLTK punkt_tab resource is not loadable: {exc}")
    return {
        "files": [{"name": path.name, "bytes": path.stat().st_size} for path in files],
        "vocabSize": config["vocab_size"],
        "samplingRate": preprocessor["sampling_rate"],
        "punktTab": str(punkt_tab),
    }


def validate_ffmpeg(ffmpeg_path):
    if not ffmpeg_path.is_file():
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Configured FFmpeg executable is missing")
    try:
        subprocess.run(
            [str(ffmpeg_path), "-version"],
            check=True,
            capture_output=True,
            timeout=20,
            env=os.environ.copy(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", f"Configured FFmpeg is not executable: {exc}")


def import_whisperx():
    try:
        import torch
        import whisperx
        # Small CPU alignment jobs suffer from model-loading thread contention.
        # Bound this runner only; retain a lower explicitly configured limit.
        torch.set_num_threads(min(MAX_CPU_THREADS, torch.get_num_threads()))
    except Exception as exc:  # noqa: BLE001 - dependency errors need one clear boundary
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", f"WhisperX is unavailable: {exc}")
    return whisperx


def probe(model_directory, ffmpeg_path):
    model = validate_local_model(model_directory)
    validate_ffmpeg(ffmpeg_path)
    whisperx = import_whisperx()
    try:
        align_model, metadata = whisperx.load_align_model(
            language_code="zh",
            device="cpu",
            model_name=str(model_directory),
            model_cache_only=True,
        )
        del align_model, metadata
    except Exception as exc:  # noqa: BLE001 - probe must report executable state
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", f"Local WhisperX alignment model could not load: {exc}")
    print(json.dumps({
        "available": True,
        "pythonVersion": platform.python_version(),
        "whisperxVersion": str(getattr(whisperx, "__version__", "unknown")),
        "device": "cpu",
        "model": model,
        "ffmpeg": str(ffmpeg_path),
    }, ensure_ascii=False))


def parse_request(model_directory, ffmpeg_path):
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", f"Alignment request is not JSON: {exc}")
    if not isinstance(request, dict):
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", "Alignment request must be an object")
    required = {
        "inputPath", "text", "language", "durationMs", "cueId", "cueFingerprint", "audioContentHash",
    }
    if set(request) != required:
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", "Alignment request fields are invalid")
    input_path = controlled_input(request["inputPath"])
    validate_ffmpeg(ffmpeg_path)
    text = request["text"]
    language = request["language"]
    duration_ms = request["durationMs"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", "Known text is invalid")
    if not isinstance(language, str) or not language or len(language) > MAX_LANGUAGE_LENGTH:
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", "Language is invalid")
    if not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms < 1:
        fail("SPEECH_ALIGNMENT_INPUT_INVALID", "Audio duration is invalid")
    return request, input_path


def align(model_directory, ffmpeg_path):
    model = validate_local_model(model_directory)
    request, input_path = parse_request(model_directory, ffmpeg_path)
    enable_offline_environment(model_directory, ffmpeg_path)
    whisperx = import_whisperx()
    # This executor is scheduled in the CPU lane; it must not use the shared GPU.
    device = "cpu"
    language_code = request["language"].split("-", 1)[0].lower()
    try:
        audio = whisperx.load_audio(str(input_path))
        actual_duration_seconds = len(audio) / 16_000.0
        if actual_duration_seconds <= 0:
            fail("SPEECH_ALIGNMENT_INPUT_INVALID", "Audio contains no samples")
        align_model, metadata = whisperx.load_align_model(
            language_code=language_code,
            device=device,
            model_name=str(model_directory),
            model_cache_only=True,
        )
        # This is forced alignment: the only segment text comes from the
        # caller's known cue text. We intentionally never call whisperx.load_model
        # or whisperx.transcribe here.
        segments = [{
            "start": 0.0,
            "end": actual_duration_seconds,
            "text": request["text"],
        }]
        aligned = whisperx.align(
            segments,
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
    except RunnerFailure:
        raise
    except Exception as exc:  # noqa: BLE001 - map provider failures to one boundary
        fail("SPEECH_ALIGNMENT_EXECUTION_ERROR", f"WhisperX alignment failed: {exc}")

    raw_words = aligned.get("word_segments") or []
    if not raw_words or len(raw_words) > MAX_WORDS:
        fail("SPEECH_ALIGNMENT_EXECUTION_ERROR", "WhisperX returned no bounded word alignment")
    words = []
    previous_end_ms = 0
    for item in raw_words:
        if not isinstance(item, dict):
            continue
        word_text = str(item.get("word", "")).strip()
        start = item.get("start")
        end = item.get("end")
        if not word_text or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        start_ms = round(float(start) * 1_000)
        end_ms = round(float(end) * 1_000)
        if start_ms < 0 or end_ms <= start_ms:
            fail("SPEECH_ALIGNMENT_EXECUTION_ERROR", "WhisperX returned invalid word timing")
        if start_ms < previous_end_ms:
            fail("SPEECH_ALIGNMENT_EXECUTION_ERROR", "WhisperX returned overlapping word timing")
        if end_ms > round(actual_duration_seconds * 1_000):
            fail("SPEECH_ALIGNMENT_EXECUTION_ERROR", "WhisperX returned timing beyond the audio")
        confidence = item.get("score")
        word = {"text": word_text, "startMs": start_ms, "endMs": end_ms}
        if isinstance(confidence, (int, float)):
            word["confidence"] = max(0.0, min(1.0, round(float(confidence), 3)))
        words.append(word)
        previous_end_ms = end_ms
    if not words:
        fail("SPEECH_ALIGNMENT_EXECUTION_ERROR", "WhisperX returned no usable word timing")
    print(json.dumps({
        "schemaVersion": 1,
        "cueId": request["cueId"],
        "cueFingerprint": request["cueFingerprint"],
        "audioContentHash": request["audioContentHash"],
        "language": request["language"],
        "source": "whisperx",
        "words": words,
    }, ensure_ascii=False, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser(description="AEONQUILL offline WhisperX alignment runner")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true")
    mode.add_argument("--align", action="store_true")
    parser.add_argument("--model-directory", required=True)
    parser.add_argument("--ffmpeg-path", required=True)
    args = parser.parse_args()
    model_directory = controlled_directory(args.model_directory)
    ffmpeg_path = Path(args.ffmpeg_path).resolve(strict=True)
    if not ffmpeg_path.is_file():
        fail("SPEECH_ALIGNMENT_UNAVAILABLE", "Configured FFmpeg path is not a file")
    enable_offline_environment(model_directory, ffmpeg_path)
    if args.probe:
        probe(model_directory, ffmpeg_path)
    else:
        align(model_directory, ffmpeg_path)


if __name__ == "__main__":
    try:
        main()
    except RunnerFailure as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001 - keep stdout path-free and bounded
        print(f"SPEECH_ALIGNMENT_EXECUTION_ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
