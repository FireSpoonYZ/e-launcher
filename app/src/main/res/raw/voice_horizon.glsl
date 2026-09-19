#version 300 es
// Faithful WebGL 2 port of the Super Assistant production Horizon material:
// superassistant/Packages/ChatGPTAvatar/Resources/ChatGPTAvatar/
// HorizonShader/HorizonShader.metal. Runtime shape and Codex scaling remain
// owned by the separate full-resolution composite.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vGenerated;

uniform sampler2D uImage_0;

// BEGIN EDITABLE HORIZON MATERIAL
// Raw normalized shader-space RGB. These are not display-sRGB hex values.
struct HorizonPalette {
  vec4 shadowColor;
  vec4 midLowColor;
  vec4 midHighColor;
  vec4 highlightColor;
};

// Palette indexes: 0 default, 1 blue, 2 green, 3 yellow, 4 pink, 5 orange, 6 purple.
const HorizonPalette materialDefaultPalette = HorizonPalette(
  vec4(0.3556343913078308, 0.35915476083755493, 1.0, 1.0),
  vec4(0.6850882768630981, 0.8027492761611938, 1.0, 1.0),
  vec4(1.0, 1.0, 1.0, 1.0),
  vec4(0.7647287845611572, 0.8149269819259644, 1.0, 1.0)
);
const HorizonPalette materialBluePalette = HorizonPalette(
  vec4(0.0, 0.182326898, 0.776186228, 1.0),
  vec4(0.401119828, 0.753617108, 1.0, 1.0),
  vec4(1.0, 1.0, 1.0, 1.0),
  vec4(0.643137276, 0.80392158, 0.984313786, 1.0)
);
const HorizonPalette materialGreenPalette = HorizonPalette(
  vec4(0.0, 0.627581179, 0.131065607, 1.0),
  vec4(0.482586682, 0.819607854, 0.646261632, 1.0),
  vec4(1.0, 1.0, 1.0, 1.0),
  vec4(0.760784388, 0.917647064, 0.807843208, 1.0)
);
const HorizonPalette materialYellowPalette = HorizonPalette(
  vec4(1.0, 0.615798414, 0.0, 1.0),
  vec4(1.0, 0.896790802, 0.285905391, 1.0),
  vec4(1.0, 1.0, 1.0, 1.0),
  vec4(0.992156863, 0.894745171, 0.617015302, 1.0)
);
const HorizonPalette materialPinkPalette = HorizonPalette(
  vec4(0.941176474, 0.466666669, 0.686274529, 1.0),
  vec4(0.984313726, 0.749019623, 0.843137264, 1.0),
  vec4(1.0, 1.0, 1.0, 1.0),
  vec4(0.988235295, 0.896634519, 0.934801519, 1.0)
);
const HorizonPalette materialOrangePalette = HorizonPalette(
  vec4(0.933333337, 0.42786175, 0.12191844, 1.0),
  vec4(1.0, 0.727038801, 0.307055056, 1.0),
  vec4(1.0, 1.0, 1.0, 1.0),
  vec4(1.0, 0.913937926, 0.745554626, 1.0)
);
const HorizonPalette materialPurplePalette = HorizonPalette(
  vec4(0.53725493, 0.321568638, 0.933333337, 1.0),
  vec4(0.663499951, 0.613026738, 1.0, 1.0),
  vec4(1.0, 1.0, 1.0, 1.0),
  vec4(0.920169115, 0.883867264, 0.988235295, 1.0)
);

HorizonPalette materialPaletteForIndex(uint paletteIndex) {
  switch (paletteIndex) {
    case 1u:
      return materialBluePalette;
    case 2u:
      return materialGreenPalette;
    case 3u:
      return materialYellowPalette;
    case 4u:
      return materialPinkPalette;
    case 5u:
      return materialOrangePalette;
    case 6u:
      return materialPurplePalette;
    default:
      return materialDefaultPalette;
  }
}

// Each ramp smoothly transitions between its start and end values.
const float materialMidLowRampStart = 0.3522728383541107;
const float materialMidLowRampEnd = 0.7400000095367432;
const float materialMidHighRampStart = 0.4113636016845703;
const float materialMidHighRampEnd = 0.5586364269256592;
const float materialHighlightRampStart = 0.3431819975376129;
const float materialHighlightRampEnd = 0.6200000047683716;
// END EDITABLE HORIZON MATERIAL

uniform float uWaveFrame;
uniform float uBaseShaderFrame;
uniform float uWaveAmplitude;
uniform float uTextureFlowFrame;
uniform float uTextureEdgeWarp;
uniform float uListeningTextureNoiseScale;
uniform vec2 uSpeakingWatercolorOffset0;
uniform vec2 uSpeakingWatercolorOffset1;
uniform vec2 uSpeakingWatercolorOffset2;
uniform uint uPaletteIndex;

out vec4 fragColor;

vec3 rotateX(vec3 value, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(value.x, c * value.y - s * value.z, s * value.y + c * value.z);
}

vec3 rotateY(vec3 value, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * value.x + s * value.z, value.y, -s * value.x + c * value.z);
}

vec3 rotateZ(vec3 value, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * value.x - s * value.y, s * value.x + c * value.y, value.z);
}

vec3 rotateEulerXYZ(vec3 value, vec3 rotation) {
  vec3 transformed = rotateX(value, rotation.x);
  transformed = rotateY(transformed, rotation.y);
  transformed = rotateZ(transformed, rotation.z);
  return transformed;
}

vec3 mappingPoint(vec3 value, vec3 location, vec3 rotation, vec3 scale) {
  return rotateEulerXYZ(value * scale, rotation) + location;
}

uint rotateBits(uint value, uint shift) {
  return (value << shift) | (value >> (32u - shift));
}

void hashMix(inout uint a, inout uint b, inout uint c) {
  a -= c;
  a ^= rotateBits(c, 4u);
  c += b;
  b -= a;
  b ^= rotateBits(a, 6u);
  a += c;
  c -= b;
  c ^= rotateBits(b, 8u);
  b += a;
  a -= c;
  a ^= rotateBits(c, 16u);
  c += b;
  b -= a;
  b ^= rotateBits(a, 19u);
  a += c;
  c -= b;
  c ^= rotateBits(b, 4u);
  b += a;
}

void hashFinal(inout uint a, inout uint b, inout uint c) {
  c ^= b;
  c -= rotateBits(b, 14u);
  a ^= c;
  a -= rotateBits(c, 11u);
  b ^= a;
  b -= rotateBits(a, 25u);
  c ^= b;
  c -= rotateBits(b, 16u);
  a ^= c;
  a -= rotateBits(c, 4u);
  b ^= a;
  b -= rotateBits(a, 14u);
  c ^= b;
  c -= rotateBits(b, 24u);
}

uint hashUint2(uint x, uint y) {
  uint a = 0xdeadbeefu + (2u << 2u) + 13u;
  uint b = a;
  uint c = a;
  b += y;
  a += x;
  hashFinal(a, b, c);
  return c;
}

uint hashUint4(uint x, uint y, uint z, uint w) {
  uint a = 0xdeadbeefu + (4u << 2u) + 13u;
  uint b = a;
  uint c = a;
  a += x;
  b += y;
  c += z;
  hashMix(a, b, c);
  a += w;
  hashFinal(a, b, c);
  return c;
}

uint hashInt4(ivec4 value) {
  return hashUint4(
    uint(value.x),
    uint(value.y),
    uint(value.z),
    uint(value.w)
  );
}

float hashUint2ToFloat(uint x, uint y) {
  return float(hashUint2(x, y)) / float(0xffffffffu);
}

float hashVec2ToFloat(vec2 value) {
  return hashUint2ToFloat(
    floatBitsToUint(value.x),
    floatBitsToUint(value.y)
  );
}

vec4 randomVec4Offset(float seed) {
  return vec4(
    100.0 + hashVec2ToFloat(vec2(seed, 0.0)) * 100.0,
    100.0 + hashVec2ToFloat(vec2(seed, 1.0)) * 100.0,
    100.0 + hashVec2ToFloat(vec2(seed, 2.0)) * 100.0,
    100.0 + hashVec2ToFloat(vec2(seed, 3.0)) * 100.0
  );
}

float fadeNoise(float value) {
  return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
}

float signedComponent(float value, uint flag) {
  return flag != 0u ? -value : value;
}

float noiseGradient(uint hash, vec4 value) {
  uint h = hash & 31u;
  float u = h < 24u ? value.x : value.y;
  float v = h < 16u ? value.y : value.z;
  float s = h < 8u ? value.z : value.w;
  return signedComponent(u, h & 1u) +
    signedComponent(v, h & 2u) +
    signedComponent(s, h & 4u);
}

float triMix(
  float v0,
  float v1,
  float v2,
  float v3,
  float v4,
  float v5,
  float v6,
  float v7,
  vec3 factor
) {
  float x1 = 1.0 - factor.x;
  float y1 = 1.0 - factor.y;
  float z1 = 1.0 - factor.z;
  return z1 *
    (y1 * (v0 * x1 + v1 * factor.x) +
      factor.y * (v2 * x1 + v3 * factor.x)) +
    factor.z *
    (y1 * (v4 * x1 + v5 * factor.x) +
      factor.y * (v6 * x1 + v7 * factor.x));
}

float quadMix(
  float v0,
  float v1,
  float v2,
  float v3,
  float v4,
  float v5,
  float v6,
  float v7,
  float v8,
  float v9,
  float v10,
  float v11,
  float v12,
  float v13,
  float v14,
  float v15,
  vec4 factor
) {
  return mix(
    triMix(v0, v1, v2, v3, v4, v5, v6, v7, factor.xyz),
    triMix(v8, v9, v10, v11, v12, v13, v14, v15, factor.xyz),
    factor.w
  );
}

float perlin4(vec4 value) {
  ivec4 cell = ivec4(floor(value));
  vec4 fraction = value - floor(value);
  vec4 curve = vec4(
    fadeNoise(fraction.x),
    fadeNoise(fraction.y),
    fadeNoise(fraction.z),
    fadeNoise(fraction.w)
  );

  return quadMix(
    noiseGradient(hashInt4(cell + ivec4(0, 0, 0, 0)), fraction - vec4(0.0, 0.0, 0.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 0, 0, 0)), fraction - vec4(1.0, 0.0, 0.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(0, 1, 0, 0)), fraction - vec4(0.0, 1.0, 0.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 1, 0, 0)), fraction - vec4(1.0, 1.0, 0.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(0, 0, 1, 0)), fraction - vec4(0.0, 0.0, 1.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 0, 1, 0)), fraction - vec4(1.0, 0.0, 1.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(0, 1, 1, 0)), fraction - vec4(0.0, 1.0, 1.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 1, 1, 0)), fraction - vec4(1.0, 1.0, 1.0, 0.0)),
    noiseGradient(hashInt4(cell + ivec4(0, 0, 0, 1)), fraction - vec4(0.0, 0.0, 0.0, 1.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 0, 0, 1)), fraction - vec4(1.0, 0.0, 0.0, 1.0)),
    noiseGradient(hashInt4(cell + ivec4(0, 1, 0, 1)), fraction - vec4(0.0, 1.0, 0.0, 1.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 1, 0, 1)), fraction - vec4(1.0, 1.0, 0.0, 1.0)),
    noiseGradient(hashInt4(cell + ivec4(0, 0, 1, 1)), fraction - vec4(0.0, 0.0, 1.0, 1.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 0, 1, 1)), fraction - vec4(1.0, 0.0, 1.0, 1.0)),
    noiseGradient(hashInt4(cell + ivec4(0, 1, 1, 1)), fraction - vec4(0.0, 1.0, 1.0, 1.0)),
    noiseGradient(hashInt4(cell + ivec4(1, 1, 1, 1)), fraction - vec4(1.0, 1.0, 1.0, 1.0)),
    curve
  );
}

vec4 noiseRepeat4(vec4 value) {
  vec4 precisionCorrection = 0.5 * step(vec4(1000000.0), abs(value));
  return value - vec4(100000.0) * trunc(value / vec4(100000.0)) +
    precisionCorrection;
}

float signedNoise4(vec4 value) {
  return 0.8344 * perlin4(noiseRepeat4(value));
}

float noiseFbm4Detail1Normalized(vec4 value, float roughness) {
  float frequency = 1.0;
  float amplitude = 1.0;
  float maxAmplitude = 0.0;
  float sum = 0.0;

  sum += signedNoise4(frequency * value) * amplitude;
  maxAmplitude += amplitude;
  amplitude *= roughness;
  frequency *= 2.0;

  sum += signedNoise4(frequency * value) * amplitude;
  maxAmplitude += amplitude;
  return 0.5 * sum / maxAmplitude + 0.5;
}

vec3 noiseColor4Detail1Normalized(
  vec3 coordinate,
  float w,
  float scale,
  float roughness
) {
  vec4 point = vec4(coordinate, w) * scale;
  return vec3(
    noiseFbm4Detail1Normalized(point, roughness),
    noiseFbm4Detail1Normalized(point + randomVec4Offset(4.0), roughness),
    noiseFbm4Detail1Normalized(point + randomVec4Offset(5.0), roughness)
  );
}

ivec3 voronoiHashPcg3d(ivec3 signedValue) {
  uvec3 value = uvec3(signedValue);
  value = value * 1664525u + uvec3(1013904223u);
  value.x += value.y * value.z;
  value.y += value.z * value.x;
  value.z += value.x * value.y;
  value ^= uvec3(ivec3(value) >> 16);
  value.x += value.y * value.z;
  value.y += value.z * value.x;
  value.z += value.x * value.y;
  return ivec3(value);
}

vec3 voronoiHashInt3ToVec3(ivec3 value) {
  return vec3(voronoiHashPcg3d(value) & ivec3(0x7fffffff)) *
    (1.0 / float(0x7fffffff));
}

vec3 voronoiF1Position3Squared(vec3 coordinate, float randomness) {
  vec3 cellPositionFloat = floor(coordinate);
  vec3 localPosition = coordinate - cellPositionFloat;
  ivec3 cellPosition = ivec3(cellPositionFloat);

  float minDistanceSquared = 3.402823466e+38;
  vec3 targetPosition = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        if (i != 0 && j != 0 && k != 0) {
          continue;
        }

        ivec3 cellOffset = ivec3(i, j, k);
        vec3 pointPosition = vec3(cellOffset) +
          voronoiHashInt3ToVec3(cellPosition + cellOffset) * randomness;
        vec3 delta = pointPosition - localPosition;
        float distanceSquared = dot(delta, delta);
        if (distanceSquared < minDistanceSquared) {
          minDistanceSquared = distanceSquared;
          targetPosition = pointPosition;
        }
      }
    }
  }

  return targetPosition + cellPositionFloat;
}

vec3 fractalVoronoiF1Position3Specialized(vec3 coordinate) {
  vec3 point = coordinate * 8.0;
  vec3 position = vec3(0.0);
  float amplitude = 1.0;
  float octaveScale = 1.0;

  vec3 octavePosition = voronoiF1Position3Squared(
    point * octaveScale,
    0.7185189723968506
  );
  position = mix(position, octavePosition / octaveScale, amplitude);
  octaveScale *= 2.0;
  amplitude *= 0.5;

  octavePosition = voronoiF1Position3Squared(
    point * octaveScale,
    0.7185189723968506
  );
  position = mix(position, octavePosition / octaveScale, amplitude);
  octaveScale *= 2.0;
  amplitude *= 0.5;

  octavePosition = voronoiF1Position3Squared(
    point * octaveScale,
    0.7185189723968506
  );
  position = mix(
    position,
    mix(position, octavePosition / octaveScale, amplitude),
    0.7999999523162842
  );
  return position / 8.0;
}


vec4 ramp_color_ramp_006(float fac) {
  if (fac <= materialHighlightRampStart) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= materialHighlightRampEnd) {
    float t = clamp((fac - materialHighlightRampStart) / max(materialHighlightRampEnd - materialHighlightRampStart, 0.000001), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    return mix(vec4(1.0, 1.0, 1.0, 1.0), vec4(0.0, 0.0, 0.0, 1.0), t);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 ramp_color_ramp_005(float fac) {
  if (fac <= materialMidHighRampStart) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= materialMidHighRampEnd) {
    float t = clamp((fac - materialMidHighRampStart) / max(materialMidHighRampEnd - materialMidHighRampStart, 0.000001), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    return mix(vec4(1.0, 1.0, 1.0, 1.0), vec4(0.0, 0.0, 0.0, 1.0), t);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 ramp_color_ramp_009(float fac) {
  if (fac <= materialMidLowRampStart) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= materialMidLowRampEnd) {
    float t = clamp((fac - materialMidLowRampStart) / max(materialMidLowRampEnd - materialMidLowRampStart, 0.000001), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    return mix(vec4(1.0, 1.0, 1.0, 1.0), vec4(0.0, 0.0, 0.0, 1.0), t);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 ramp_color_ramp_007(float fac) {
  if (fac <= 0.0) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= 1.0) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

void main() {
  HorizonPalette materialPalette = materialPaletteForIndex(uPaletteIndex);
  vec4 materialShadowColor = materialPalette.shadowColor;
  vec4 materialMidLowColor = materialPalette.midLowColor;
  vec4 materialMidHighColor = materialPalette.midHighColor;
  vec4 materialHighlightColor = materialPalette.highlightColor;
  float frame = uBaseShaderFrame;
  float waveFrame = uWaveFrame;
  float textureFlowFrame = uTextureFlowFrame;
  // This pass produces only the animated material. A separate full-resolution
  // composite pass owns the circle SDF, reveal, and mic-driven scaling.
  vec3 scaledGenerated = vGenerated;
  vec3 n_texture_coordinate_001_generated = scaledGenerated;
vec3 n_mapping_003_vector = mappingPoint(n_texture_coordinate_001_generated, vec3(0.0, -0.14000000059604645, 0.0), vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
  vec2 textureEdgeCentered = scaledGenerated.xy - vec2(0.5);
  float textureEdgeRadius = length(textureEdgeCentered);
  float textureEdgeWeight = smoothstep(0.015, 0.44, textureEdgeRadius);
  vec2 textureEdgeDirection = textureEdgeRadius > 0.000001
    ? textureEdgeCentered / textureEdgeRadius
    : vec2(0.0);
  n_mapping_003_vector.xy += textureEdgeDirection * textureEdgeWeight * uTextureEdgeWarp;
float n_value_001_value = waveFrame / 100.0;
vec3 n_noise_texture_009_color = noiseColor4Detail1Normalized(n_mapping_003_vector, n_value_001_value, 1.0, 0.4000000059604645);
vec3 n_vector_math_015_vector = n_noise_texture_009_color - vec3(0.5, 0.5, 0.5);
float n_value_003_value = (0.800000011920929) * uWaveAmplitude;
vec3 n_vector_math_016_vector = n_vector_math_015_vector * n_value_003_value;
vec3 n_vector_math_020_vector = n_mapping_003_vector + n_vector_math_016_vector;
vec3 n_noise_texture_color = noiseColor4Detail1Normalized(n_vector_math_020_vector, textureFlowFrame / 10.0, 200.0, 0.5);
vec3 n_vector_math_026_vector = (n_noise_texture_color - vec3(0.5, 0.5, 0.5)) * uListeningTextureNoiseScale;
vec3 n_vector_math_028_vector = n_vector_math_026_vector * 0.05999999865889549;
float n_value_value = 0.800000011920929;
vec3 n_vector_math_004_vector = n_vector_math_020_vector * n_value_value;
vec3 n_vector_math_010_vector = n_vector_math_028_vector + n_vector_math_004_vector;
  n_vector_math_010_vector.xy += uSpeakingWatercolorOffset0;
vec4 n_image_texture_004_color = textureGrad(uImage_0, (n_vector_math_010_vector).xy, dFdx((n_vector_math_010_vector).xy) * (1.0 / 1.5), dFdy((n_vector_math_010_vector).xy) * (1.0 / 1.5));
float n_math_002_value = (n_image_texture_004_color).r - 0.5;
vec3 n_vector_math_005_vector = n_vector_math_004_vector;
vec3 n_vector_math_013_vector = n_vector_math_028_vector + n_vector_math_005_vector;
float n_math_004_value = 1.0 - (n_vector_math_013_vector).y;
vec3 n_combine_xyz_005_vector = vec3((n_vector_math_013_vector).x, n_math_004_value, 0.0);
  n_combine_xyz_005_vector.xy += uSpeakingWatercolorOffset0;
vec4 n_image_texture_005_color = textureGrad(uImage_0, (n_combine_xyz_005_vector).xy, dFdx((n_combine_xyz_005_vector).xy) * (1.0 / 1.5), dFdy((n_combine_xyz_005_vector).xy) * (1.0 / 1.5));
float n_math_005_value = (n_image_texture_005_color).r - 0.5;
float baseShaderFrameBlend120 =
  clamp(0.5 - 0.5*cos(frame * 2.0 * 3.14159265 / 120.0), 0.0, 1.0);
float n_mix_012_result_float = mix(n_math_002_value, n_math_005_value, baseShaderFrameBlend120);
float n_value_002_value = 0.2 - 0.06*cos((frame - 1.0) * 2.0 * 3.14159265 / 120.0);
float n_math_003_value = n_mix_012_result_float * n_value_002_value;
vec3 n_combine_xyz_004_vector = vec3(n_math_003_value, n_math_003_value, 0.0);
vec3 n_voronoi_texture_position = fractalVoronoiF1Position3Specialized(n_vector_math_020_vector);
vec3 n_vector_math_022_vector = n_voronoi_texture_position - vec3(0.5, 0.5, 0.5);
vec3 n_vector_math_023_vector = n_vector_math_022_vector * 0.25999999046325684;
vec3 n_vector_math_vector = n_combine_xyz_004_vector + n_vector_math_023_vector;
vec3 n_vector_math_001_vector = n_vector_math_020_vector + n_vector_math_vector;
vec3 n_mapping_006_vector = mappingPoint(n_vector_math_001_vector, vec3(0.0, 0.5600000023841858, 0.0), vec3(0.0, 0.7853981852531433, 0.0), vec3(1.0, 1.0, 1.0));
vec4 n_color_ramp_006_color = ramp_color_ramp_006(((n_mapping_006_vector).x + (n_mapping_006_vector).y + (n_mapping_006_vector).z) / 3.0);
float n_value_005_value = 0.800000011920929;
vec3 n_mapping_vector = mappingPoint(n_vector_math_020_vector, vec3(0.03999999910593033, 0.019999999552965164, 0.0), vec3(0.0, 0.0, 0.0), vec3(n_value_005_value));
vec3 n_vector_math_021_vector = n_vector_math_028_vector + n_mapping_vector;
  n_vector_math_021_vector.xy += uSpeakingWatercolorOffset1;
vec4 n_image_texture_006_color = textureGrad(uImage_0, (n_vector_math_021_vector).xy, dFdx((n_vector_math_021_vector).xy) * (1.0 / 1.5), dFdy((n_vector_math_021_vector).xy) * (1.0 / 1.5));
float n_math_006_value = (n_image_texture_006_color).r - 0.5;
vec3 n_mapping_001_vector = mappingPoint(n_vector_math_020_vector, vec3(-0.03999999910593033, -0.019999999552965164, 0.0), vec3(0.0, 0.0, 0.0), vec3(n_value_005_value));
vec3 n_vector_math_024_vector = n_vector_math_028_vector + n_mapping_001_vector;
float n_math_008_value = 1.0 - (n_vector_math_024_vector).y;
vec3 n_combine_xyz_007_vector = vec3((n_vector_math_024_vector).x, n_math_008_value, 0.0);
  n_combine_xyz_007_vector.xy += uSpeakingWatercolorOffset1;
vec4 n_image_texture_007_color = textureGrad(uImage_0, (n_combine_xyz_007_vector).xy, dFdx((n_combine_xyz_007_vector).xy) * (1.0 / 1.5), dFdy((n_combine_xyz_007_vector).xy) * (1.0 / 1.5));
float n_math_009_value = (n_image_texture_007_color).r - 0.5;
float n_mix_013_result_float = mix(n_math_006_value, n_math_009_value, baseShaderFrameBlend120);
float n_value_004_value = 0.2 - 0.06*cos((frame - 1.0) * 2.0 * 3.14159265 / 80.0);
float n_math_007_value = n_mix_013_result_float * n_value_004_value;
vec3 n_combine_xyz_006_vector = vec3(n_math_007_value, n_math_007_value, 0.0);
vec3 n_vector_math_003_vector = n_combine_xyz_006_vector + n_vector_math_023_vector;
vec3 n_vector_math_002_vector = n_vector_math_020_vector + n_vector_math_003_vector;
vec3 n_mapping_004_vector = mappingPoint(n_vector_math_002_vector, vec3(0.0, 0.25999999046325684, 0.0), vec3(0.0, 0.7853981852531433, 0.0), vec3(1.0, 1.0, 1.0));
vec4 n_color_ramp_005_color = ramp_color_ramp_005(((n_mapping_004_vector).x + (n_mapping_004_vector).y + (n_mapping_004_vector).z) / 3.0);
vec3 n_texture_coordinate_002_generated = scaledGenerated;
vec3 n_mapping_007_vector = mappingPoint(n_texture_coordinate_002_generated, vec3(-0.3199999928474426, 0.0, 0.0), vec3(0.0, 0.0, -1.5707963705062866), vec3(1.0, 1.0, 1.0));
float n_gradient_texture_clamped = clamp((n_mapping_007_vector).x, 0.0, 1.0);
float n_gradient_texture_fac = n_gradient_texture_clamped * n_gradient_texture_clamped
  * (3.0 - 2.0 * n_gradient_texture_clamped);
float n_value_007_value = 0.800000011920929;
vec3 n_mapping_002_vector = mappingPoint(n_vector_math_020_vector, vec3(-0.07999999821186066, -0.03999999910593033, 0.0), vec3(0.0, 0.0, 0.0), vec3(n_value_007_value));
vec3 n_vector_math_027_vector = n_vector_math_028_vector + n_mapping_002_vector;
  n_vector_math_027_vector.xy += uSpeakingWatercolorOffset2;
vec4 n_image_texture_008_color = textureGrad(uImage_0, (n_vector_math_027_vector).xy, dFdx((n_vector_math_027_vector).xy) * (1.0 / 1.5), dFdy((n_vector_math_027_vector).xy) * (1.0 / 1.5));
vec4 n_mix_002_result_color = mix(n_image_texture_008_color, vec4(1.0, 1.0, 1.0, 1.0), clamp(((vec4(vec3(n_gradient_texture_fac), 1.0)).r + (vec4(vec3(n_gradient_texture_fac), 1.0)).g + (vec4(vec3(n_gradient_texture_fac), 1.0)).b) / 3.0, 0.0, 1.0));
float n_math_010_value = (n_mix_002_result_color).r - 0.5;
vec3 n_mapping_005_vector = mappingPoint(n_vector_math_020_vector, vec3(-0.9599999189376831, 0.05999999865889549, 0.0), vec3(0.0, 0.0, 0.0), vec3(n_value_007_value));
vec3 n_vector_math_030_vector = n_vector_math_028_vector + n_mapping_005_vector;
float n_math_012_value = 1.0 - (n_vector_math_030_vector).y;
vec3 n_combine_xyz_009_vector = vec3((n_vector_math_030_vector).x, n_math_012_value, 0.0);
  n_combine_xyz_009_vector.xy += uSpeakingWatercolorOffset2;
vec4 n_image_texture_009_color = textureGrad(uImage_0, (n_combine_xyz_009_vector).xy, dFdx((n_combine_xyz_009_vector).xy) * (1.0 / 1.5), dFdy((n_combine_xyz_009_vector).xy) * (1.0 / 1.5));
vec4 n_mix_001_result_color = mix(n_image_texture_009_color, vec4(1.0, 1.0, 1.0, 1.0), clamp(((vec4(vec3(n_gradient_texture_fac), 1.0)).r + (vec4(vec3(n_gradient_texture_fac), 1.0)).g + (vec4(vec3(n_gradient_texture_fac), 1.0)).b) / 3.0, 0.0, 1.0));
float n_math_013_value = (n_mix_001_result_color).r - 0.5;
float n_mix_014_result_float = mix(n_math_010_value, n_math_013_value, baseShaderFrameBlend120);
float n_value_006_value = 0.14 - 0.06*cos((frame - 1.0) * 2.0 * 3.14159265 / 100.0);
float n_math_011_value = n_mix_014_result_float * n_value_006_value;
vec3 n_combine_xyz_008_vector = vec3(n_math_011_value, n_math_011_value, 0.0);
vec3 n_vector_math_007_vector = n_combine_xyz_008_vector + n_vector_math_023_vector;
vec3 n_vector_math_006_vector = n_vector_math_020_vector + n_vector_math_007_vector;
vec3 n_mapping_009_vector = mappingPoint(n_vector_math_006_vector, vec3(0.0, 0.12000000476837158, 0.0), vec3(0.0, 0.7853981852531433, 0.0), vec3(1.0, 1.0, 1.0));
vec4 n_color_ramp_009_color = ramp_color_ramp_009(((n_mapping_009_vector).x + (n_mapping_009_vector).y + (n_mapping_009_vector).z) / 3.0);
vec3 n_texture_coordinate_generated = scaledGenerated;
vec3 n_mapping_008_vector = mappingPoint(n_texture_coordinate_generated, vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
vec4 n_color_ramp_007_color = ramp_color_ramp_007(((n_mapping_008_vector).x + (n_mapping_008_vector).y + (n_mapping_008_vector).z) / 3.0);
vec4 n_mix_010_result_color = mix(vec4(0.0, 0.0, 0.0, 1.0), materialShadowColor, clamp(((n_color_ramp_007_color).r + (n_color_ramp_007_color).g + (n_color_ramp_007_color).b) / 3.0, 0.0, 1.0));
vec4 n_mix_011_result_color = mix(n_mix_010_result_color, materialMidLowColor, clamp(((n_color_ramp_009_color).r + (n_color_ramp_009_color).g + (n_color_ramp_009_color).b) / 3.0, 0.0, 1.0));
vec4 n_mix_008_result_color = mix(n_mix_011_result_color, materialMidHighColor, clamp(((n_color_ramp_005_color).r + (n_color_ramp_005_color).g + (n_color_ramp_005_color).b) / 3.0, 0.0, 1.0));
vec4 n_mix_009_result_color = mix(n_mix_008_result_color, materialHighlightColor, clamp(((n_color_ramp_006_color).r + (n_color_ramp_006_color).g + (n_color_ramp_006_color).b) / 3.0, 0.0, 1.0));
vec4 materialColor = vec4((n_mix_009_result_color).rgb, 1.0);
  fragColor = materialColor;
}
