"""Legacy v1 waveform graph, retained for desktop verification.

For current WeChat builds use export-swift-compat.py (fixed-shape CNN).

Optional build tool; the mini program has no Python/runtime dependencies.
Requires onnx 1.20.1, onnxruntime 1.24.4 and numpy 1.26.4.
Original SwiftF0 model/decoder: Lars Nieradzik, MIT (see models license).
Modifications: raw float32 outputs, folded constants, opset-13/IR-8 graph.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile

import numpy as np
import onnx
from onnx import helper as h, TensorProto as T, numpy_helper
import onnxruntime as ort

SOURCE_SHA256 = '6385e8c2ebc3872e82c9ff5946228de44cd3be77a750ea53698b7dbfe94b0a22'


def export(source, output):
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Expected the original SwiftF0 0.3.0 model; SHA256 mismatch')
    output.mkdir(parents=True, exist_ok=True)
    model = onnx.load(source)
    model.graph.value_info.extend([
        h.make_tensor_value_info('v429', T.FLOAT, [1, 'frames', 95]),
        h.make_tensor_value_info('v437', T.FLOAT, [1, 'frames'])])
    raw = onnx.utils.Extractor(model).extract_model(['audio'], ['v429', 'v437'])
    names = {'v429': 'pitch_logits', 'v437': 'voicing_logits'}
    for node in raw.graph.node:
        for i, name in enumerate(node.output):
            if name in names:
                node.output[i] = names[name]
    for value in raw.graph.output:
        value.name = names[value.name]
    raw.producer_name = 'HumNote SwiftF0 adapter'
    onnx.checker.check_model(raw)
    with tempfile.TemporaryDirectory(prefix='humnote-swift-') as temporary:
        raw_path = Path(temporary) / 'raw.onnx'
        target = Path(temporary) / 'folded.onnx'
        onnx.save(raw, raw_path)
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        options.optimized_model_filepath = str(target)
        ort.InferenceSession(str(raw_path), sess_options=options, providers=['CPUExecutionProvider'])
        result = onnx.load(target)
    assert all(n.domain in ['', 'ai.onnx'] for n in result.graph.node)
    assert not any(n.op_type in ['GatherElements', 'ScatterElements'] for n in result.graph.node)
    assert all(t.data_type != T.DOUBLE for t in result.graph.initializer)
    initializers = {t.name: numpy_helper.to_array(t) for t in result.graph.initializer}
    for node in result.graph.node:
        if node.op_type in ['ReduceMean', 'ReduceMax'] and len(node.input) == 2:
            axes = initializers[node.input[1]].tolist()
            del node.input[1:]
            node.attribute.extend([h.make_attribute('axes', axes)])
            for attribute in list(node.attribute):
                if attribute.name == 'noop_with_empty_axes':
                    node.attribute.remove(attribute)
        for attribute in list(node.attribute):
            if node.op_type == 'Shape' and attribute.name == 'start':
                assert attribute.i == 0
                node.attribute.remove(attribute)
            if node.op_type == 'Reshape' and attribute.name == 'allowzero':
                assert attribute.i == 0
                node.attribute.remove(attribute)
    del result.opset_import[:]
    result.opset_import.extend([h.make_opsetid('', 13)])
    result.ir_version = 8
    used = {name for node in result.graph.node for name in node.input}
    for tensor in list(result.graph.initializer):
        if tensor.name not in used:
            result.graph.initializer.remove(tensor)
    onnx.checker.check_model(result)
    model_path = output / 'swift-f0-wechat.onnx'
    onnx.save(result, model_path)

    # Verify acoustic output parity before writing metadata consumed by the app.
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    options.log_severity_level = 3
    adapted = ort.InferenceSession(str(model_path), sess_options=options, providers=['CPUExecutionProvider'])
    original = ort.InferenceSession(str(source), sess_options=options, providers=['CPUExecutionProvider'])
    centers = numpy_helper.to_array(next(t for t in model.graph.initializer if t.name == 'v438'))
    for length in [16000, 32000, 480000]:
        signal = (.15 * np.sin(2 * np.pi * 220 * np.arange(length) / 16000)).astype(np.float32)[None, :]
        expected_pitch, expected_confidence = original.run(None, {
            'audio': signal, 'fmin': np.array(46.875, np.float32), 'fmax': np.array(2093.75, np.float32)})
        logits, voicing = adapted.run(None, {'audio': signal})
        pitch = []
        for row in logits[0]:
            peak = int(np.argmax(row))
            bins = np.arange(max(0, peak - 1), min(95, peak + 2))
            weights = np.exp(row[bins].astype(np.float64) - float(row[peak]))
            pitch.append(np.exp((weights * np.log(centers[bins].astype(np.float64))).sum() / weights.sum()))
        assert np.max(abs(1200 * np.log2(np.array(pitch) / expected_pitch[0]))) < .001
        assert np.max(abs(1 / (1 + np.exp(-voicing[0])) - expected_confidence[0])) < 1e-5
    metadata = dict(version='0.3.0-wechat-v1', sourceSha256=SOURCE_SHA256,
                    modelSha256=hashlib.sha256(model_path.read_bytes()).hexdigest(), pitchBinCenters=centers.tolist())
    text = json.dumps(metadata, indent=2) + '\n'
    (output / 'swift-f0-meta.json').write_text(text, encoding='utf-8')
    (output / 'swift-f0-meta.js').write_text(
        '// Generated from swift-f0-meta.json; SwiftF0 0.3.0 model constants (MIT).\nmodule.exports = ' + text.strip() + ';\n', encoding='utf-8')
    print(json.dumps(dict(modelSha256=metadata['modelSha256'], bytes=model_path.stat().st_size, parity='passed')))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Original, checksum-pinned swift_f0/model.onnx')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    export(args.source, args.output)
