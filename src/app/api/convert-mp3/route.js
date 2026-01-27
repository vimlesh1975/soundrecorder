export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { writeFile, unlink, readFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function POST(req) {
    try {
        const ffmpegPath = path.join(
            process.cwd(),
            "node_modules",
            "@ffmpeg-installer",
            process.platform === "win32"
                ? "win32-x64/ffmpeg.exe"
                : "linux-x64/ffmpeg"
        );

        const formData = await req.formData();
        const file = formData.get("file");

        if (!file) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

        const inputPath = path.join(tmpdir(), `${crypto.randomUUID()}.webm`);
        const outputPath = inputPath.replace(".webm", ".mp3");

        const buffer = Buffer.from(await file.arrayBuffer());
        await writeFile(inputPath, buffer);

        await execFileAsync(ffmpegPath, [
            "-y",
            "-i",
            inputPath,
            "-vn",
            "-ab",
            "192k",
            outputPath,
        ]);

        const mp3Buffer = await readFile(outputPath);

        await unlink(inputPath);
        await unlink(outputPath);

        return new NextResponse(mp3Buffer, {
            headers: {
                "Content-Type": "audio/mpeg",
                "Content-Disposition": 'attachment; filename="recording.mp3"',
            },
        });
    } catch (err) {
        console.error("MP3 conversion error:", err);
        return NextResponse.json(
            { error: "MP3 conversion failed", details: err.message },
            { status: 500 }
        );
    }
}
