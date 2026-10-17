#!/usr/bin/env python3
"""
Panorama Maps — tools-model/train_vision_model.py

Trains a multi-head neural vision and optics model for Panorama Maps and exports
it to standard ONNX (Agent/models/panorama_vision_model.onnx) and JSON weights
(Agent/models/panorama_vision_weights.json).

Capabilities trained into the model:
  1. Ray Tracing: Screen-space specular reflections, ambient occlusion, light bounce gain.
  2. 3Dness (not too much): Subtle stereoscopic depth relief & parallax without distortion.
  3. Realtime Denoise & Enhance: Edge-preserving bilateral filtering & unsharp clarity.
  4. Calc & Epipolar Vectors: Spherical coordinate transformations and epipolar curvature.
  5. Wide-Angle Optics: Rectilinear and Panini compression parameters for wide FOV.
  6. View Illusion: Atmospheric depth haze and subtle perspective parallax.
  7. Adaptive Morph Movement: Dynamic easing combining cubic, ease-in, and smoothstep
     keyed on key/button press duration in ms — strictly preserving walk velocity & speed.
"""

import os
import sys
import json
import math
import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort

# Artifacts always land in Agent/models, no matter which directory the script
# is launched from.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODELS_DIR = os.path.join(REPO_ROOT, 'Agent', 'models')
DEFAULT_ONNX_PATH = os.path.join(MODELS_DIR, 'panorama_vision_model.onnx')
DEFAULT_WEIGHTS_PATH = os.path.join(MODELS_DIR, 'panorama_vision_weights.json')

def generate_synthetic_training_data(n_samples=2400, seed=42):
    """
    Generates training dataset covering panoramic camera poses, lighting conditions,
    spherical viewing rays, user interaction press durations, and ground truth optics.
    """
    np.random.seed(seed)
    
    # 16 Input features:
    # 0: ray_x, 1: ray_y, 2: ray_z (normalized view vector)
    # 3: yaw_rad, 4: pitch_rad, 5: fov_rad
    # 6: speed_mps (0.5 to 8.0)
    # 7: press_ms (10 to 1200 ms)
    # 8: tod_norm (0=night, 0.25=dawn, 0.5=noon, 0.75=dusk)
    # 9: weather_code (0=clear, 0.5=rain, 1.0=snow)
    # 10: current_zoom (0.7 to 1.5)
    # 11: distance_m (0.5 to 25.0)
    # 12: surface_height (0.0 to 3.0)
    # 13: ambient_lux_norm (0.05 to 1.0)
    # 14: edge_density (0.0 to 1.0)
    # 15: motion_velocity (0.0 to 1.0)
    
    X = np.zeros((n_samples, 16), dtype=np.float32)
    
    # Random spherical angles for view ray
    theta = np.random.uniform(-np.pi, np.pi, n_samples).astype(np.float32)
    phi = np.random.uniform(-np.pi / 2.5, np.pi / 2.5, n_samples).astype(np.float32)
    
    X[:, 0] = np.cos(phi) * np.sin(theta)  # ray_x
    X[:, 1] = np.sin(phi)                 # ray_y
    X[:, 2] = -np.cos(phi) * np.cos(theta) # ray_z
    
    X[:, 3] = np.random.uniform(-np.pi, np.pi, n_samples)      # yaw
    X[:, 4] = np.random.uniform(-np.pi/3, np.pi/3, n_samples)  # pitch
    X[:, 5] = np.random.uniform(0.5, 1.9, n_samples)           # fov (rad) ~ 30° to 110°
    X[:, 6] = np.random.uniform(0.8, 6.0, n_samples)           # speed mps
    X[:, 7] = np.random.uniform(20.0, 950.0, n_samples)        # press_ms
    X[:, 8] = np.random.uniform(0.0, 1.0, n_samples)           # time of day
    X[:, 9] = np.random.choice([0.0, 0.5, 1.0], n_samples)     # weather
    X[:, 10] = np.random.uniform(0.85, 1.25, n_samples)        # zoom
    X[:, 11] = np.random.uniform(0.5, 15.0, n_samples)         # distance m
    X[:, 12] = np.random.uniform(0.2, 2.5, n_samples)          # surface height
    X[:, 13] = np.clip(np.sin(X[:, 8] * np.pi) + 0.1, 0.05, 1.0) # ambient lux
    X[:, 14] = np.random.uniform(0.1, 0.9, n_samples)          # edge density
    X[:, 15] = np.random.uniform(0.0, 1.0, n_samples)          # velocity
    
    # Compute Ground Truth Targets for the 7 Heads:
    # Total outputs = 4 + 3 + 4 + 4 + 3 + 3 + 4 = 25 outputs
    Y = np.zeros((n_samples, 25), dtype=np.float32)
    
    for i in range(n_samples):
        # 1. Ray Tracing (indices 0..3): [ao_factor, specular_intensity, light_bounce_gain, roughness]
        # AO is stronger in corners / lower ground; Specular aligns with sun / light angle
        ground_factor = np.clip(1.0 - (X[i, 1] + 1.0) * 0.5, 0.0, 1.0)
        ao = 0.4 + 0.5 * (1.0 - ground_factor * 0.6)
        sun_dot = max(0.0, float(X[i, 0] * 0.3 + X[i, 1] * 0.8 - X[i, 2] * 0.5))
        spec = 0.1 + 0.7 * (sun_dot ** 4) * X[i, 13]
        bounce = 0.2 + 0.4 * X[i, 13] * (1.0 - X[i, 9] * 0.5)
        roughness = 0.3 + 0.4 * (1.0 - X[i, 13] * 0.5)
        Y[i, 0:4] = [ao, spec, bounce, roughness]
        
        # 2. 3Dness (indices 4..6): [subtle_parallax_scale, depth_relief_bias, depth_disparity_clipping]
        # Bounded between 0.02 and 0.07 ("not too much" to prevent motion sickness)
        parallax = 0.035 + 0.025 * np.sin(X[i, 11] * 0.2)
        relief = 0.03 + 0.02 * X[i, 14]
        clipping = 0.95
        Y[i, 4:7] = [parallax, relief, clipping]
        
        # 3. Denoise & Enhance (indices 7..10): [bilateral_spatial, bilateral_range, unsharp_boost, contrast_lift]
        # Higher denoise in dark conditions / high distance; boost sharpness on dense edges
        b_spat = 1.2 + 1.8 * (1.0 - X[i, 13])
        b_rng = 0.08 + 0.07 * (1.0 - X[i, 13])
        unsharp = 0.3 + 0.5 * X[i, 14]
        contrast = 1.0 + 0.15 * X[i, 13]
        Y[i, 7:11] = [b_spat, b_rng, unsharp, contrast]
        
        # 4. Calc & Epipolar (indices 11..14): [epipolar_curl, horizon_curvature, spherical_jacobian, irradiance_flux]
        curl = float(np.sin(X[i, 3] * 2.0) * 0.1)
        curv = float(np.cos(X[i, 4]) * 0.08)
        jac = float(1.0 / (np.cos(X[i, 4]) + 1e-4) * 0.1)
        flux = float(X[i, 13] * (1.0 + X[i, 1] * 0.3))
        Y[i, 11:15] = [curl, curv, jac, flux]
        
        # 5. Wide-Angle Optics (indices 15..17): [rectilinear_k1, panini_compression, fov_barrel_compensation]
        # Panini compression kicks in when FOV > 70 deg (1.22 rad)
        fov = X[i, 5]
        panini = float(max(0.0, min(1.0, (fov - 1.1) / 0.8)))
        rect_k1 = float(0.05 * (fov / 1.5))
        barrel = float(0.02 * (fov / 1.5))
        Y[i, 15:18] = [rect_k1, panini, barrel]
        
        # 6. View Illusion (indices 18..20): [aerial_haze, micro_wobble, depth_shift]
        haze = float(np.clip(X[i, 11] / 30.0 * (1.0 + X[i, 9] * 0.8), 0.0, 0.4))
        wobble = 0.02 * (1.0 - np.clip(X[i, 15], 0.0, 1.0))
        depth_shift = 0.015 * X[i, 10]
        Y[i, 18:21] = [haze, wobble, depth_shift]
        
        # 7. Adaptive Morph Movement (indices 21..24):
        # [w_cubic_out, w_cubic_in, w_smoothstep, dynamic_exp]
        # Depending on press_ms:
        #   Short tap (<120ms): w_cubic_out dominant (snappy response)
        #   Medium press (120-350ms): w_smoothstep dominant (smooth glide)
        #   Long press (>350ms): w_cubic_in dominant (gradual build into continuous march)
        # Crucially: sum(w_i) = 1.0, preserving duration and speed exactly!
        ms = X[i, 7]
        if ms < 120.0:
            w_out = 0.70 + 0.15 * (1.0 - ms / 120.0)
            w_in = 0.05
            w_ss = 1.0 - w_out - w_in
            exp_val = 3.0
        elif ms < 350.0:
            frac = (ms - 120.0) / 230.0
            w_out = float(0.70 * (1.0 - frac) + 0.20 * frac)
            w_ss = float(0.25 * (1.0 - frac) + 0.60 * frac)
            w_in = float(1.0 - w_out - w_ss)
            exp_val = 2.5
        else:
            frac = min(1.0, (ms - 350.0) / 450.0)
            w_in = float(0.20 * (1.0 - frac) + 0.55 * frac)
            w_ss = float(0.60 * (1.0 - frac) + 0.35 * frac)
            w_out = float(1.0 - w_in - w_ss)
            exp_val = 2.0
            
        Y[i, 21:25] = [w_out, w_in, w_ss, exp_val]
        
    return X, Y

class PanoramaVisionNetwork:
    """
    Two-layer MLP with residual skip connections and 7 multi-task heads.
    Trained via mini-batch SGD with momentum and Adam optimizer.
    """
    def __init__(self, in_dim=16, hidden_dim=64, out_dim=25, seed=42):
        np.random.seed(seed)
        # Glorot / He initialization
        self.W1 = np.random.randn(in_dim, hidden_dim).astype(np.float32) * np.sqrt(2.0 / in_dim)
        self.B1 = np.zeros(hidden_dim, dtype=np.float32)
        
        self.W2 = np.random.randn(hidden_dim, hidden_dim).astype(np.float32) * np.sqrt(2.0 / hidden_dim)
        self.B2 = np.zeros(hidden_dim, dtype=np.float32)
        
        self.W3 = np.random.randn(hidden_dim, out_dim).astype(np.float32) * np.sqrt(2.0 / hidden_dim)
        self.B3 = np.zeros(out_dim, dtype=np.float32)
        
        # Adam state
        self.mW1, self.vW1 = np.zeros_like(self.W1), np.zeros_like(self.W1)
        self.mB1, self.vB1 = np.zeros_like(self.B1), np.zeros_like(self.B1)
        self.mW2, self.vW2 = np.zeros_like(self.W2), np.zeros_like(self.W2)
        self.mB2, self.vB2 = np.zeros_like(self.B2), np.zeros_like(self.B2)
        self.mW3, self.vW3 = np.zeros_like(self.W3), np.zeros_like(self.W3)
        self.mB3, self.vB3 = np.zeros_like(self.B3), np.zeros_like(self.B3)
        self.t = 0

    def forward(self, X):
        # Layer 1 + LeakyReLU
        Z1 = X @ self.W1 + self.B1
        A1 = np.where(Z1 > 0, Z1, Z1 * 0.05)
        
        # Layer 2 + LeakyReLU + residual
        Z2 = A1 @ self.W2 + self.B2
        A2 = np.where(Z2 > 0, Z2, Z2 * 0.05) + A1 * 0.5
        
        # Output Layer
        out = A2 @ self.W3 + self.B3
        
        cache = (X, Z1, A1, Z2, A2)
        return out, cache

    def train_step(self, X_batch, Y_batch, lr=0.003):
        self.t += 1
        N = X_batch.shape[0]
        pred, cache = self.forward(X_batch)
        
        loss = np.mean((pred - Y_batch) ** 2)
        dOut = 2.0 * (pred - Y_batch) / N
        
        X, Z1, A1, Z2, A2 = cache
        
        # Backprop through Layer 3
        dW3 = A2.T @ dOut
        dB3 = np.sum(dOut, axis=0)
        dA2 = dOut @ self.W3.T
        
        # Backprop through Layer 2
        dZ2 = dA2 * np.where(Z2 > 0, 1.0, 0.05)
        dW2 = A1.T @ dZ2
        dB2 = np.sum(dZ2, axis=0)
        dA1 = dZ2 @ self.W2.T + dA2 * 0.5
        
        # Backprop through Layer 1
        dZ1 = dA1 * np.where(Z1 > 0, 1.0, 0.05)
        dW1 = X.T @ dZ1
        dB1 = np.sum(dZ1, axis=0)
        
        # Adam parameter update
        beta1, beta2, eps = 0.9, 0.999, 1e-8
        for param, dparam, m, v in [
            (self.W1, dW1, self.mW1, self.vW1), (self.B1, dB1, self.mB1, self.vB1),
            (self.W2, dW2, self.mW2, self.vW2), (self.B2, dB2, self.mB2, self.vB2),
            (self.W3, dW3, self.mW3, self.vW3), (self.B3, dB3, self.mB3, self.vB3),
        ]:
            m[:] = beta1 * m + (1 - beta1) * dparam
            v[:] = beta2 * v + (1 - beta2) * (dparam ** 2)
            m_hat = m / (1.0 - beta1 ** self.t)
            v_hat = v / (1.0 - beta2 ** self.t)
            param -= lr * m_hat / (np.sqrt(v_hat) + eps)
            
        return loss

def export_onnx(net, output_path=None):
    """
    Exports the trained PanoramaVisionNetwork into a standard ONNX model.
    """
    output_path = output_path or DEFAULT_ONNX_PATH
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    # Input definition: Float[batch, 16]
    input_info = helper.make_tensor_value_info('features', TensorProto.FLOAT, [None, 16])
    output_info = helper.make_tensor_value_info('predictions', TensorProto.FLOAT, [None, 25])
    
    # Tensors for weights & biases
    W1_tensor = helper.make_tensor('W1', TensorProto.FLOAT, [16, 64], net.W1.flatten())
    B1_tensor = helper.make_tensor('B1', TensorProto.FLOAT, [64], net.B1.flatten())
    W2_tensor = helper.make_tensor('W2', TensorProto.FLOAT, [64, 64], net.W2.flatten())
    B2_tensor = helper.make_tensor('B2', TensorProto.FLOAT, [64], net.B2.flatten())
    W3_tensor = helper.make_tensor('W3', TensorProto.FLOAT, [64, 25], net.W3.flatten())
    B3_tensor = helper.make_tensor('B3', TensorProto.FLOAT, [25], net.B3.flatten())
    res_scale = helper.make_tensor('res_scale', TensorProto.FLOAT, [1], [0.5])
    
    nodes = [
        # Layer 1: Gemm + LeakyRelu
        helper.make_node('Gemm', ['features', 'W1', 'B1'], ['z1'], alpha=1.0, beta=1.0),
        helper.make_node('LeakyRelu', ['z1'], ['a1'], alpha=0.05),
        
        # Layer 2: Gemm + LeakyRelu + Residual Add
        helper.make_node('Gemm', ['a1', 'W2', 'B2'], ['z2'], alpha=1.0, beta=1.0),
        helper.make_node('LeakyRelu', ['z2'], ['act2'], alpha=0.05),
        helper.make_node('Mul', ['a1', 'res_scale'], ['res_branch']),
        helper.make_node('Add', ['act2', 'res_branch'], ['a2']),
        
        # Layer 3: Output Gemm
        helper.make_node('Gemm', ['a2', 'W3', 'B3'], ['predictions'], alpha=1.0, beta=1.0),
    ]
    
    graph = helper.make_graph(
        nodes,
        'PanoramaVisionModel',
        [input_info],
        [output_info],
        [W1_tensor, B1_tensor, W2_tensor, B2_tensor, W3_tensor, B3_tensor, res_scale]
    )
    
    opset = helper.make_opsetid('', 17)
    model = helper.make_model(
        graph,
        producer_name='Arena_Vision_Engine',
        ir_version=10,
        opset_imports=[opset]
    )
    
    onnx.checker.check_model(model)
    onnx.save(model, output_path)
    print(f"✓ ONNX model exported and validated: {output_path} ({os.path.getsize(output_path)} bytes)")
    
    # Verify with onnxruntime
    session = ort.InferenceSession(output_path)
    dummy_input = np.ones((1, 16), dtype=np.float32)
    out = session.run(None, {'features': dummy_input})
    print(f"✓ ONNX Runtime validation passed: output shape = {out[0].shape}")

def export_json_weights(net, output_path=None):
    """
    Exports the trained weights in JSON format for the browser WebGL / JS engine.
    """
    output_path = output_path or DEFAULT_WEIGHTS_PATH
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    payload = {
        'model': 'PanoramaVisionModel',
        'version': '1.0.0',
        'inDim': 16,
        'hiddenDim': 64,
        'outDim': 25,
        'heads': {
            'rayTracing': {'offset': 0, 'size': 4, 'names': ['ao_factor', 'specular_intensity', 'light_bounce_gain', 'roughness']},
            'depth3D': {'offset': 4, 'size': 3, 'names': ['subtle_parallax_scale', 'depth_relief_bias', 'depth_clipping']},
            'denoise': {'offset': 7, 'size': 4, 'names': ['bilateral_spatial', 'bilateral_range', 'unsharp_boost', 'contrast_lift']},
            'calc': {'offset': 11, 'size': 4, 'names': ['epipolar_curl', 'horizon_curvature', 'spherical_jacobian', 'irradiance_flux']},
            'wideAngle': {'offset': 15, 'size': 3, 'names': ['rectilinear_k1', 'panini_compression', 'fov_barrel_compensation']},
            'viewIllusion': {'offset': 18, 'size': 3, 'names': ['aerial_haze', 'micro_wobble', 'depth_shift']},
            'adaptiveMorph': {'offset': 21, 'size': 4, 'names': ['w_cubic_out', 'w_cubic_in', 'w_smoothstep', 'dynamic_exp']},
        },
        'weights': {
            'W1': net.W1.tolist(),
            'B1': net.B1.tolist(),
            'W2': net.W2.tolist(),
            'B2': net.B2.tolist(),
            'W3': net.W3.tolist(),
            'B3': net.B3.tolist(),
        }
    }
    with open(output_path, 'w') as f:
        json.dump(payload, f, indent=2)
    print(f"✓ Browser/Desktop JSON weights exported: {output_path} ({os.path.getsize(output_path)} bytes)")

def train():
    print("=== Training Panorama Vision & Optics Neural Model ===")
    X_train, Y_train = generate_synthetic_training_data(n_samples=3200, seed=101)
    X_val, Y_val = generate_synthetic_training_data(n_samples=400, seed=202)
    
    net = PanoramaVisionNetwork(in_dim=16, hidden_dim=64, out_dim=25, seed=42)
    
    batch_size = 64
    epochs = 40
    n_batches = len(X_train) // batch_size
    
    initial_pred, _ = net.forward(X_val)
    initial_loss = float(np.mean((initial_pred - Y_val) ** 2))
    print(f"Epoch 0/40 - Initial Val Loss: {initial_loss:.6f}")
    
    for epoch in range(1, epochs + 1):
        indices = np.random.permutation(len(X_train))
        epoch_loss = 0.0
        for b in range(n_batches):
            b_idx = indices[b * batch_size : (b + 1) * batch_size]
            b_loss = net.train_step(X_train[b_idx], Y_train[b_idx], lr=0.004)
            epoch_loss += b_loss
        epoch_loss /= n_batches
        
        if epoch % 10 == 0 or epoch == epochs:
            val_pred, _ = net.forward(X_val)
            val_loss = float(np.mean((val_pred - Y_val) ** 2))
            print(f"Epoch {epoch:2d}/{epochs} - Train Loss: {epoch_loss:.6f} | Val Loss: {val_loss:.6f}")
            
    val_pred, _ = net.forward(X_val)
    final_loss = float(np.mean((val_pred - Y_val) ** 2))
    print(f"Training completed successfully! Final Val MSE: {final_loss:.6f}")
    
    export_onnx(net, DEFAULT_ONNX_PATH)
    export_json_weights(net, DEFAULT_WEIGHTS_PATH)

if __name__ == '__main__':
    train()
