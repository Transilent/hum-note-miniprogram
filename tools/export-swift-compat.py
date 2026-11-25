"""Build a fixed-shape SwiftF0 CNN; perform spectral features in JavaScript.

SwiftF0 0.3.0, Lars Nieradzik (MIT). This changes graph layout, not weights.
Requires the same optional Python dependencies as export-swift-model.py.
"""
import argparse
import base64
from collections import Counter
import copy
import hashlib
import json
from pathlib import Path
import runpy
import tempfile

import numpy as np
import onnx
from onnx import helper as h, numpy_helper, TensorProto as T
import onnxruntime as ort

FRAMES = 152


def export(source, output, include_oracle=False):
    output.mkdir(parents=True, exist_ok=True)
    old = runpy.run_path(str(Path(__file__).with_name('export-swift-model.py')))
    with tempfile.TemporaryDirectory(prefix='humnote-swift-cnn-') as directory:
        directory = Path(directory)
        old['export'](source, directory)
        base = onnx.shape_inference.infer_shapes(onnx.load(directory / 'swift-f0-wechat.onnx'))
        meta = json.loads((directory / 'swift-f0-meta.json').read_text(encoding='utf-8'))
    first = next(n for n in base.graph.node if n.op_type == 'Conv')
    feature_name = first.input[0]
    cnn = onnx.utils.Extractor(base).extract_model([feature_name], ['pitch_logits', 'voicing_logits'])
    cnn.graph.input[0].name = 'features'
    cnn.graph.input[0].type.tensor_type.shape.CopyFrom(h.make_tensor_value_info('features', T.FLOAT, [1, 3, 128, FRAMES]).type.tensor_type.shape)
    cnn.graph.input.extend([h.make_tensor_value_info('frame_mask', T.FLOAT, [1, 1, 1, FRAMES])])
    tensors = {t.name: t for t in cnn.graph.initializer}
    rewritten = []
    axes_name = 'humnote_axis_2'
    cnn.graph.initializer.extend([numpy_helper.from_array(np.array([2], dtype=np.int64), axes_name)])
    for index, original in enumerate(cnn.graph.node):
        node = copy.deepcopy(original)
        for i, name in enumerate(node.input):
            if name == feature_name:
                node.input[i] = 'features'
        if node.op_type != 'Conv':
            rewritten.append(node)
            continue
        original_output = node.output[0]
        weight = tensors[node.input[1]]
        one_dimensional = len(weight.dims) == 3
        prefix = 'humnote_' + str(index)
        if one_dimensional:
            expanded = numpy_helper.from_array(np.expand_dims(numpy_helper.to_array(weight), 2), prefix + '_weight')
            cnn.graph.initializer.extend([expanded])
            node.input[1] = expanded.name
            rewritten.append(h.make_node('Unsqueeze', [node.input[0], axes_name], [prefix + '_input']))
            node.input[0] = prefix + '_input'
            for attr in node.attribute:
                values = list(attr.ints)
                if attr.name in ['kernel_shape', 'dilations', 'strides']:
                    del attr.ints[:]
                    attr.ints.extend([1] + values)
                elif attr.name == 'pads':
                    del attr.ints[:]
                    attr.ints.extend([0, values[0], 0, values[1]])
        node.output[0] = prefix + '_raw'
        rewritten.append(node)
        masked = prefix + '_masked' if one_dimensional else original_output
        # Zero every hidden padded frame, including convolution bias. This makes
        # end-of-recording results equivalent to an unpadded variable-length CNN.
        rewritten.append(h.make_node('Mul', [node.output[0], 'frame_mask'], [masked]))
        if one_dimensional:
            rewritten.append(h.make_node('Squeeze', [masked, axes_name], [original_output]))
    del cnn.graph.node[:]
    cnn.graph.node.extend(rewritten)
    del cnn.graph.value_info[:]
    for value, shape in zip(cnn.graph.output, [[1, FRAMES, 95], [1, FRAMES]]):
        value.type.tensor_type.shape.CopyFrom(h.make_tensor_value_info(value.name, T.FLOAT, shape).type.tensor_type.shape)
    used = {v for n in cnn.graph.node for v in n.input}
    for tensor in list(cnn.graph.initializer):
        if tensor.name not in used:
            cnn.graph.initializer.remove(tensor)
    cnn.producer_name = 'HumNote SwiftF0 fixed CNN adapter v2'
    constants = {t.name: numpy_helper.to_array(t) for t in cnn.graph.initializer}
    for node in cnn.graph.node:
        if node.op_type in ['Squeeze', 'Unsqueeze'] and len(node.input) == 2:
            node.attribute.extend([h.make_attribute('axes', constants[node.input[1]].tolist())])
            del node.input[1:]
    used = {v for n in cnn.graph.node for v in n.input}
    for tensor in list(cnn.graph.initializer):
        if tensor.name not in used:
            cnn.graph.initializer.remove(tensor)
    del cnn.opset_import[:]
    cnn.opset_import.extend([h.make_opsetid('', 11)])
    cnn.ir_version = 7
    cnn = onnx.shape_inference.infer_shapes(cnn)
    onnx.checker.check_model(cnn)
    target = output / 'swift-f0-cnn.onnx'
    onnx.save(cnn, target)
    probe = h.make_model(h.make_graph([h.make_node('Add', ['input', 'bias'], ['output'])], 'HumNote inference probe',
        [h.make_tensor_value_info('input', T.FLOAT, [1, 2])], [h.make_tensor_value_info('output', T.FLOAT, [1, 2])],
        [numpy_helper.from_array(np.array([2, 2], np.float32), 'bias')]), opset_imports=[h.make_opsetid('', 11)])
    probe.ir_version = 8
    onnx.checker.check_model(probe)
    onnx.save(probe, output / 'inference-probe.onnx')
    assert not {'Shape', 'Gather', 'MatMul', 'Pad', 'Div', 'Log', 'Sqrt'} & {n.op_type for n in cnn.graph.node}
    arrays = {t.name: numpy_helper.to_array(t) for t in base.graph.initializer}
    windows = []
    for size in [1024, 2048, 512]:
        matrix = next(a for a in arrays.values() if a.shape == (size // 2 + 1, 128))
        filters = []
        for band in range(128):
            column = matrix[:, band]
            indices = np.flatnonzero(column)
            start, end = int(indices[0]), int(indices[-1]) + 1
            filters.append(dict(start=start, weights=column[start:end].tolist()))
        windows.append(dict(size=size, filters=filters))
    tables = json.dumps(dict(frames=FRAMES, bands=128, windows=windows), separators=(',', ':'))
    (output / 'swift-f0-features-data.js').write_text('// SwiftF0 0.3.0 spectral filter coefficients (MIT); generated, do not edit.\nmodule.exports=' + tables + ';\n', encoding='utf-8')
    for file_name, module_name in [('swift-f0-cnn.onnx', 'swift-f0-cnn-data.js'), ('inference-probe.onnx', 'inference-probe-data.js')]:
        raw = (output / file_name).read_bytes()
        embedded = dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(), base64=base64.b64encode(raw).decode('ascii'))
        (output / module_name).write_text('// SwiftF0 model bytes (MIT); generated, do not edit.\nmodule.exports=' + json.dumps(embedded, separators=(',', ':')) + ';\n', encoding='utf-8')
    meta.update(version='0.3.0-wechat-v3', modelSha256=hashlib.sha256(target.read_bytes()).hexdigest(), model='swift-f0-cnn.onnx',
                probeSha256=hashlib.sha256((output / 'inference-probe.onnx').read_bytes()).hexdigest(),
                featuresSha256=hashlib.sha256((output / 'swift-f0-features-data.js').read_bytes()).hexdigest())
    text = json.dumps(meta, indent=2)
    (output / 'swift-f0-meta.json').write_text(text + '\n', encoding='utf-8')
    (output / 'swift-f0-meta.js').write_text('// SwiftF0 0.3.0 model metadata (MIT); generated.\nmodule.exports=' + text + ';\n', encoding='utf-8')

    # Compare both CNN conversion and partial-window masking against the old
    # complete waveform model, using its actual spectral features.
    frontend = onnx.utils.Extractor(base).extract_model(['audio'], [feature_name])
    with tempfile.TemporaryDirectory(prefix='humnote-swift-check-') as directory:
        frontend_path = Path(directory) / 'frontend.onnx'
        onnx.save(frontend, frontend_path)
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.log_severity_level = 3
        spectral = ort.InferenceSession(str(frontend_path), sess_options=options, providers=['CPUExecutionProvider'])
        old_session = ort.InferenceSession(base.SerializeToString(), sess_options=options, providers=['CPUExecutionProvider'])
        session = ort.InferenceSession(str(target), sess_options=options, providers=['CPUExecutionProvider'])
        max_difference = 0.0
        for count in [12, 62, 128, 140, 152]:
            signal = np.random.default_rng(count).normal(0, .1, size=(1, count * 256 + 137)).astype(np.float32)
            feature = spectral.run(None, {'audio': signal})[0]
            padded = np.zeros((1, 3, 128, FRAMES), np.float32)
            padded[:, :, :, :count] = feature
            mask = np.zeros((1, 1, 1, FRAMES), np.float32)
            mask[:, :, :, :count] = 1
            expected = old_session.run(None, {'audio': signal})
            actual = session.run(None, {'features': padded, 'frame_mask': mask})
            for a, b in zip(expected, actual):
                max_difference = max(max_difference, float(np.max(abs(a - b[:, :count]))))
        assert max_difference < 1e-4, max_difference
        # Optional oracle for the desktop JavaScript parity harness.
        if include_oracle:
            onnx.save(frontend, output / 'swift-f0-frontend-oracle.onnx')
    print(json.dumps(dict(bytes=target.stat().st_size, sha256=meta['modelSha256'], operators=dict(Counter(n.op_type for n in cnn.graph.node)),
                          maskedCnnMaxLogitDifference=max_difference)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--include-oracle', action='store_true', help='Also save the desktop-only spectral parity model; do not bundle it')
    arguments = parser.parse_args()
    export(arguments.source, arguments.output, arguments.include_oracle)
