// ECHELON sim — minimal 3-vector.
//
// The sim used THREE.Vector3 for positions and steering scratch, which meant a
// ~600 KB render library had to be present just to move a bot. This implements
// only the subset the simulation touches, with the same method names and the
// same chaining behaviour, so ported call sites read identically and the server
// needs no dependencies at all.

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }

  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) {
    this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z;
    return this;
  }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }

  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }

  normalize() {
    const l = this.length();
    return l > 1e-9 ? this.multiplyScalar(1 / l) : this.set(0, 0, 0);
  }

  distanceTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }

  // Wire form: plain array, so snapshots never serialize class metadata.
  toArray() { return [this.x, this.y, this.z]; }
  fromArray(a) { return this.set(a[0], a[1], a[2]); }
}

export const vec3 = (x, y, z) => new Vec3(x, y, z);
