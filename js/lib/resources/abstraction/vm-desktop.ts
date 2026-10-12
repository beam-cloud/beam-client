import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import type { VM } from "./vm";
import type { VMProcess } from "./vm-runtime";
import type {
  VMDesktopClickOptions,
  VMDesktopScrollOptions,
} from "../../types/vm";
import { VMError } from "./vm-api";

/** Authenticated desktop control using the same guest tools as Python. */
export class VMDesktop {
  constructor(private vm: VM) {}
  get url(): string | undefined {
    return this.vm.desktopUrl;
  }
  private async ready(): Promise<void> {
    await this.vm.runtime();
    if (!this.vm.info.spec.desktop)
      throw new VMError(
        "Create this VM with desktop:true to use desktop controls",
      );
    await this.vm.wait({ services: true });
  }
  private async run(args: string[], stdin?: string): Promise<string> {
    await this.ready();
    const process = await this.vm.exec(args, { cwd: "/", stdin, wait: true });
    let code: number;
    try {
      code = await process.wait({ timeoutMs: 30_000 });
    } catch (error) {
      await process.kill().catch(() => {});
      throw error;
    }
    if (code !== 0)
      throw new VMError(
        (await process.stderr.read()) || `Desktop command failed: ${args[0]}`,
      );
    return (await process.stdout.read()).trim();
  }
  /** Capture PNG bytes, optionally saving them to a local file. */
  async screenshot(path?: string): Promise<Buffer> {
    return this.vm.keepAlive(async () => {
      const remote = `/run/beam-desktop/screenshot-${randomUUID()}.png`;
      let captured = false;
      try {
        await this.run(["scrot", "--overwrite", remote]);
        captured = true;
        const data = await this.vm.fs.readBytes(remote);
        if (path) await writeFile(path, data);
        return data;
      } finally {
        if (captured) await this.vm.fs.remove(remote);
      }
    });
  }
  async screenSize(): Promise<{ width: number; height: number }> {
    const [width, height] = (await this.run(["xdotool", "getdisplaygeometry"]))
      .split(/\s+/)
      .map(Number);
    return { width, height };
  }
  async resize(width: number, height: number): Promise<void> {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 320 ||
      width > 4096 ||
      height < 200 ||
      height > 2160
    )
      throw new VMError("Desktop resolution must be 320–4096 by 200–2160");
    const mode = `${width}x${height}`;
    await this.vm.keepAlive(async () => {
      if (
        !(await this.run(["xrandr", "--query"])).split(/\s+/).includes(mode)
      ) {
        await this.run([
          "xrandr",
          "--newmode",
          mode,
          String((width * height * 60) / 1_000_000),
          String(width),
          "0",
          "0",
          String(width),
          String(height),
          "0",
          "0",
          String(height),
        ]);
        await this.run(["xrandr", "--addmode", "VNC-0", mode]);
      }
      await this.run(["xrandr", "--output", "VNC-0", "--mode", mode]);
    });
  }
  private move(x: number, y: number): string[] {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new VMError("Mouse coordinates must be finite numbers");
    return ["mousemove", String(Math.trunc(x)), String(Math.trunc(y))];
  }
  async moveMouse(x: number, y: number): Promise<void> {
    await this.run(["xdotool", ...this.move(x, y)]);
  }
  async click(opts: VMDesktopClickOptions = {}): Promise<void> {
    const { x, y, button = "left", count = 1 } = opts;
    const buttons = { left: 1, middle: 2, right: 3 };
    if (
      !(button in buttons) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 3
    )
      throw new VMError("Use left/middle/right and a click count from 1 to 3");
    if ((x === undefined) !== (y === undefined))
      throw new VMError("Provide both mouse coordinates");
    await this.run([
      "xdotool",
      ...(x === undefined ? [] : this.move(x, y!)),
      "click",
      "--repeat",
      String(count),
      "--delay",
      "100",
      String(buttons[button]),
    ]);
  }
  async scroll(opts: VMDesktopScrollOptions = {}): Promise<void> {
    const { direction = "down", amount = 3 } = opts;
    const buttons = { up: 4, down: 5, left: 6, right: 7 };
    if (
      !(direction in buttons) ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > 100
    )
      throw new VMError("Use up/down/left/right and 1–100 scroll steps");
    await this.run([
      "xdotool",
      "click",
      "--repeat",
      String(amount),
      String(buttons[direction]),
    ]);
  }
  async press(...keys: string[]): Promise<void> {
    if (!keys.length || keys.some((key) => !key || key.startsWith("-")))
      throw new VMError("Provide X11 key names, such as Return or ctrl+l");
    await this.run(["xdotool", "key", "--clearmodifiers", ...keys]);
  }
  /** Paste literal UTF-8 text, including Unicode and newlines, using the clipboard. */
  async write(text: string): Promise<void> {
    await this.vm.keepAlive(async () => {
      await this.run(["xclip", "-selection", "clipboard", "-in"], text);
      await this.press("ctrl+v");
    });
  }
  async drag(
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): Promise<void> {
    await this.run([
      "xdotool",
      ...this.move(start.x, start.y),
      "mousedown",
      "1",
      ...this.move(end.x, end.y),
      "mouseup",
      "1",
    ]);
  }
  async launch(command: string[]): Promise<VMProcess> {
    await this.ready();
    return this.vm.exec(command);
  }
  /** Record a guest MP4 until stopRecording(handle), then download it with vm.fs. */
  async record(path: string, opts: { fps?: number } = {}): Promise<VMProcess> {
    const fps = opts.fps ?? 30;
    if (!path.startsWith("/") || !Number.isInteger(fps) || fps < 1 || fps > 60)
      throw new VMError(
        "Recording requires an absolute guest path and 1–60 FPS",
      );
    const { width, height } = await this.screenSize();
    return this.vm.exec([
      "ffmpeg",
      "-nostdin",
      "-n",
      "-f",
      "x11grab",
      "-video_size",
      `${width}x${height}`,
      "-framerate",
      String(fps),
      "-i",
      ":1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(fps),
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      path,
    ]);
  }
  async stopRecording(recording: VMProcess): Promise<void> {
    await this.vm.assertRuntime(recording.containerId);
    // Pin the signal to the recording's boot, even if this VM restarts during the call.
    const signal = await recording.sandbox_instance.exec(
      ["kill", "-INT", String(recording.pid)],
      { wait: true },
    );
    if ((await signal.wait()) !== 0)
      throw new VMError(
        (await signal.stderr.read()) || "Unable to stop recording",
      );
    await recording.wait({ timeoutMs: 30_000 });
  }
}
