/**
 * Battle camera: an orbit rig with damped goals, screen-space panning that
 * stays parallel to the battlefield plane, screen shake, and a top-down
 * preset. Input is fed in by scene.js so the same rig works headless in tests.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

export class BattleCamera {
  constructor(domElement, aspect, { fov = 46, distance = 40, pitch = 50, yaw = -32 } = {}) {
    this.camera = new THREE.PerspectiveCamera(fov, aspect, 0.5, 1600);
    this.target = new THREE.Vector3(0, 0, 0);
    this.goalTarget = this.target.clone();

    this.yaw = yaw * DEG;
    this.pitch = pitch * DEG;
    this.distance = distance;
    this.goalYaw = this.yaw;
    this.goalPitch = this.pitch;
    this.goalDistance = distance;

    this.minPitch = 20 * DEG;
    this.maxPitch = 80 * DEG;
    this.minDistance = 18;
    this.maxDistance = 70;
    this.bounds = new THREE.Box2(new THREE.Vector2(-40, -40), new THREE.Vector2(40, 40));

    this.shake = 0;
    this.shakeSeed = Math.random() * 100;
    this.topDown = false;
    this.savedPitch = pitch * DEG;

    this._panStart = new THREE.Vector2();
    this._targetStart = new THREE.Vector3();
    this._dom = domElement;
    this.apply();
  }

  setBounds(width, height) {
    this.bounds.min.set(-width * 0.62, -height * 0.62);
    this.bounds.max.set(width * 0.62, height * 0.62);
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  orbit(dx, dy) {
    this.goalYaw -= dx * 0.006;
    this.goalPitch = THREE.MathUtils.clamp(this.goalPitch + dy * 0.005, this.minPitch, this.maxPitch);
    if (this.goalPitch > 78 * DEG) this.topDown = true;
  }

  zoom(delta) {
    const k = Math.exp(delta * 0.0012);
    this.goalDistance = THREE.MathUtils.clamp(this.goalDistance * k, this.minDistance, this.maxDistance);
  }

  /** Pan in screen space: move the rig target along the ground plane. */
  pan(dx, dy) {
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const scale = this.distance * 0.0016;
    this.goalTarget.addScaledVector(right, -dx * scale);
    this.goalTarget.addScaledVector(fwd, dy * scale);
    this.clampTarget(this.goalTarget);
  }

  clampTarget(v) {
    v.x = THREE.MathUtils.clamp(v.x, this.bounds.min.x, this.bounds.max.x);
    v.z = THREE.MathUtils.clamp(v.z, this.bounds.min.y, this.bounds.max.y);
    v.y = 0;
  }

  focus(v, { snap = false, distance = null } = {}) {
    this.goalTarget.copy(v);
    this.clampTarget(this.goalTarget);
    if (distance) this.goalDistance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
    if (snap) {
      this.target.copy(this.goalTarget);
      this.distance = this.goalDistance;
    }
  }

  setTopDown(on) {
    this.topDown = Boolean(on);
    if (this.topDown) {
      this.savedPitch = Math.max(this.savedPitch, this.goalPitch);
      this.goalPitch = 88 * DEG;
      this.goalYaw = 0;
      this.goalDistance = THREE.MathUtils.clamp(Math.max(this.goalDistance, 44), this.minDistance, this.maxDistance);
    } else {
      this.goalPitch = THREE.MathUtils.clamp(this.savedPitch || 50 * DEG, this.minPitch, this.maxPitch);
    }
  }

  addShake(amount) {
    this.shake = Math.min(1.6, this.shake + amount);
  }

  beginDrag(button, x, y) {
    this._panStart.set(x, y);
    this._targetStart.copy(this.goalTarget);
    this._mode = button === 0 ? 'orbit' : 'pan';
  }

  dragTo(x, y) {
    const dx = x - this._panStart.x;
    const dy = y - this._panStart.y;
    if (this._mode === 'orbit') this.orbit(dx, dy);
    else this.pan(dx, dy);
    this._panStart.set(x, y);
  }

  endDrag() {
    this._mode = null;
  }

  apply() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const x = this.target.x + this.distance * cp * Math.sin(this.yaw);
    const z = this.target.z + this.distance * cp * Math.cos(this.yaw);
    const y = this.target.y + this.distance * sp;
    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    if (this.shake > 0.001) {
      const t = performance.now() * 0.06 + this.shakeSeed;
      const a = this.shake * 0.6;
      this.camera.position.x += Math.sin(t * 1.7) * a;
      this.camera.position.y += Math.sin(t * 2.3 + 1.1) * a * 0.7;
      this.camera.position.z += Math.cos(t * 1.9 + 0.4) * a;
      this.camera.rotateZ(Math.sin(t * 1.3) * this.shake * 0.01);
    }
  }

  update(dt) {
    const k = 1 - Math.pow(0.0015, dt);
    this.target.lerp(this.goalTarget, k);
    this.distance += (this.goalDistance - this.distance) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    let dYaw = this.goalYaw - this.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.yaw += dYaw * k;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.apply();
  }

  /** Ray from a pointer position, in world space. */
  rayFrom(ndc, out = new THREE.Raycaster()) {
    out.setFromCamera(ndc, this.camera);
    return out;
  }
}
