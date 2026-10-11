import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function record(id: number, body = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(body.length + 4);
  header.writeUInt16BE(id, 2);
  return Buffer.concat([header, body]);
}
function shorts(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => data.writeUInt16BE(value, i * 2));
  return data;
}
function points(values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => data.writeInt32BE(value, i * 4));
  return data;
}
function string(value: string): Buffer {
  return Buffer.from(value.length % 2 ? value + "\0" : value);
}
function real(value: number): Buffer {
  let exponent = 64;
  while (value >= 1) {
    value /= 16;
    exponent++;
  }
  while (value < 1 / 16) {
    value *= 16;
    exponent--;
  }
  let mantissa = BigInt(Math.round(value * 2 ** 56));
  const data = Buffer.alloc(8);
  data[0] = exponent;
  for (let i = 7; i > 0; i--) {
    data[i] = Number(mantissa & 255n);
    mantissa >>= 8n;
  }
  return data;
}
function polygon(layer: number, xy: number[]): Buffer {
  return Buffer.concat([
    record(0x0800),
    record(0x0d02, shorts(layer)),
    record(0x0e02, shorts(20)),
    record(0x1003, points([...xy, ...xy.slice(0, 2)])),
    record(0x1100),
  ]);
}
function cell(name: string, elements: Buffer[]): Buffer {
  return Buffer.concat([
    record(0x0502, Buffer.alloc(24)),
    record(0x0606, string(name)),
    ...elements,
    record(0x0700),
  ]);
}

/** A genuine GDS artifact added to an isolated copy of the CLI-built counter. */
export function physicalSnapshot(base: string, suffix = "fixture"): string {
  const directory = mkdtempSync(join(tmpdir(), "hdlview-mask-session-"));
  cpSync(base, directory, { recursive: true });
  const gds = join(directory, "fixture.gds"),
    layers = join(directory, "fixture.lyp"),
    layout = join(directory, "layout.json");
  writeFileSync(
    gds,
    Buffer.concat([
      record(0x0002, shorts(600)),
      record(0x0102, Buffer.alloc(24)),
      record(0x0206, string("fixture")),
      record(0x0305, Buffer.concat([real(0.001), real(1e-9)])),
      cell("leaf", [polygon(68, [0, 0, 10000, 0, 10000, 10000, 0, 10000])]),
      cell("counter", [
        polygon(68, [20000, 30000, 70000, 30000, 70000, 40000, 20000, 40000]),
        polygon(69, [50000, 10000, 55000, 10000, 55000, 80000, 50000, 80000]),
        // A concave outline exercises triangulation independently of rectangles.
        polygon(
          68,
          [
            70000, 60000, 85000, 60000, 85000, 75000, 80000, 75000, 80000,
            65000, 70000, 65000,
          ],
        ),
        Buffer.concat([
          record(0x0a00),
          record(0x1206, string("leaf")),
          record(0x1003, points([20000, 20000])),
          record(0x1100),
        ]),
      ]),
      record(0x0400),
    ]),
  );
  writeFileSync(
    layers,
    `<layer-properties>${[68, 69].map((layer, i) => `<properties><name>met${i + 1}.${suffix}</name><source>${layer}/20@1</source><fill-color>${i ? "#ffff00" : "#0000ff"}</fill-color><frame-color>#ffffff</frame-color><dither-pattern>I0</dither-pattern></properties>`).join("")}</layer-properties>`,
  );
  writeFileSync(
    layout,
    JSON.stringify({
      dbu: 1000,
      die: [0, 0, 100000, 100000],
      core: [10000, 10000, 90000, 90000],
      layers: ["met1", "met2"],
      cuts: [],
      masters: [{ name: "leaf", class: "CORE", width: 10000, height: 10000 }],
      instances: [["first", 0, 20000, 20000, 30000, 30000, "R0"]],
      pins: [],
      nets: ["fast[0]"],
      wires: [
        [[20000, 30000, 70000, 40000, 0]],
        [[50000, 10000, 55000, 80000, 0]],
      ],
      power: [[], []],
    }),
  );
  const snapshot = JSON.parse(
    readFileSync(join(directory, "snapshot.json"), "utf8"),
  );
  snapshot.directory = directory;
  snapshot.id += "-" + suffix;
  snapshot.physical_run = {
    status: "complete",
    flow_error: null,
    directory,
    state: {},
    reports: [],
    layout,
    gds,
    layer_file: layers,
    checks: null,
  };
  const path = join(directory, "snapshot.json");
  writeFileSync(path, JSON.stringify(snapshot));
  return path;
}
