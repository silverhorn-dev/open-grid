"""Convert Bumble's Private Detector (SavedModel, float16) into a TF.js graph model (float32).

TF.js has no float16 tensors. The SavedModel keeps its variables in float32 but computes in
float16 (Keras mixed precision), so the graph is frozen, every half-precision type and constant is
rewritten to float32, and the result is checked against the original before it is converted.

Usage (inside a container with tensorflow-cpu 2.15 and tensorflowjs 4.17):
    python convert-bumble.py <saved_model_dir> <output_dir> [uint8|float16]

Weights are quantised (uint8 by default, about 51 MB; float16 about 102 MB); TF.js dequantises them
to float32 when loading. Prints reference outputs for a fixed ramp input so a JS runtime can be
compared against the original model.

Input of the converted model: float32 [batch, 691200] = 480x480x3, pixels already padded to a
square with grey (128), resized to 480 and normalised with (x - 128) / 128.
Output: float32 [batch, 2], index 0 = probability "lewd".
"""
import sys

import numpy as np
import tensorflow as tf
from tensorflow.core.framework import attr_value_pb2, types_pb2
from tensorflow.python.framework.convert_to_constants import convert_variables_to_constants_v2

HALF = types_pb2.DT_HALF
FLOAT = types_pb2.DT_FLOAT


def to_float32(graph_def):
    for node in graph_def.node:
        for key, value in node.attr.items():
            if value.type == HALF:
                node.attr[key].type = FLOAT
            if value.list.type:
                types = [FLOAT if entry == HALF else entry for entry in value.list.type]
                node.attr[key].CopyFrom(attr_value_pb2.AttrValue(list=attr_value_pb2.AttrValue.ListValue(type=types)))
            if value.HasField('tensor') and value.tensor.dtype == HALF:
                array = tf.make_ndarray(value.tensor).astype(np.float32)
                node.attr[key].tensor.CopyFrom(tf.make_tensor_proto(array, dtype=tf.float32))
    return graph_def


def run(graph_def, input_name, output_name, batch):
    graph = tf.Graph()
    with graph.as_default():
        tf.graph_util.import_graph_def(graph_def, name='')
    with tf.compat.v1.Session(graph=graph) as session:
        return session.run(output_name, {input_name: batch})


def ramp():
    # x[i] = ((i % 256) - 128) / 128, easy to rebuild in JavaScript.
    return ((np.arange(691200) % 256).astype(np.float32).reshape(1, -1) - 128) / 128


def main(saved_model_dir, output_dir, quantization='uint8'):
    model = tf.saved_model.load(saved_model_dir)
    function = model.signatures['serving_default']
    frozen = convert_variables_to_constants_v2(function)
    original = frozen.graph.as_graph_def()
    input_name = frozen.inputs[0].name
    output_name = frozen.outputs[0].name
    print('input', input_name, frozen.inputs[0].shape, frozen.inputs[0].dtype)
    print('output', output_name, frozen.outputs[0].shape)

    converted = to_float32(tf.compat.v1.GraphDef.FromString(original.SerializeToString()))

    rng = np.random.default_rng(1)
    batch = (rng.integers(0, 256, size=(3, 691200)).astype(np.float32) - 128) / 128
    expected = run(original, input_name, output_name, batch.astype(np.float16))
    actual = run(converted, input_name, output_name, batch)
    difference = float(np.max(np.abs(expected - actual)))
    print('expected', expected.tolist())
    print('actual  ', actual.tolist())
    print('max difference', difference)
    if difference > 0.02:
        raise SystemExit('float32 graph differs from the original')

    print('reference ramp', run(original, input_name, output_name, ramp().astype(np.float16)).tolist())
    print('reference zeros', run(original, input_name, output_name, np.zeros((1, 691200), np.float16)).tolist())

    frozen_path = f'{output_dir}.frozen.pb'
    with open(frozen_path, 'wb') as handle:
        handle.write(converted.SerializeToString())

    from tensorflowjs.converters import converter
    converter.convert([
        '--input_format=tf_frozen_model',
        '--output_format=tfjs_graph_model',
        f'--output_node_names={output_name.split(":")[0]}',
        f'--quantize_{quantization}=*',
        frozen_path,
        output_dir,
    ])
    import os
    os.remove(frozen_path)
    print('written', output_dir)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'uint8')
