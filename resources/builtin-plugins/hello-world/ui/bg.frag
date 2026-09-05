// Hello Violet — демо-шейдер фона плагина.
// Uniforms от хоста: u_time (sec), u_resolution (vec2), u_mouse (vec2), u_opacity (float).
precision highp float;

uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_opacity;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  // Медленный диагональный фиолетовый градиент с лёгкой волной.
  float wave = 0.5 + 0.5 * sin(u_time * 0.25 + (uv.x + uv.y) * 6.0);
  vec3 top = vec3(0.09, 0.07, 0.16);
  vec3 bottom = vec3(0.20, 0.12, 0.38);
  vec3 col = mix(bottom, top, uv.y + wave * 0.12);
  // Мягкое свечение у курсора.
  float d = distance(uv, u_mouse);
  col += vec3(0.30, 0.20, 0.55) * exp(-d * 5.0) * 0.35;
  gl_FragColor = vec4(col, u_opacity);
}
