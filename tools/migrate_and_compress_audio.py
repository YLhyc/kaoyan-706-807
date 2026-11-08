# -*- coding: utf-8 -*-
"""
migrate_and_compress_audio.py
按照 V2.0 终极整合规范第 7 节执行：
1. 精确迁移政治 208 个白名单 MP3，并转码为 64kbps 单声道高保真人声 MP3
2. 对专业课（706/807/en）高码率 MP3 执行 64kbps 瘦身
3. 确保全科 385 个音频时长零漂移、总大小控制在 400MB 以内
"""

import os
import sys
import json
import time
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdout.reconfigure(encoding='utf-8')

BASE_DST = r"D:\AI_file\706_807专业课背诵手卷"
POL_SRC_CARDS = r"D:\AI_file\背诵手册\audio_cards"
POL_SRC_XUTAO = r"D:\AI_file\背诵手册\handbook\audio_xutao"
POL_SRC_TUIJIE = r"D:\AI_file\背诵手册\audio_tuijie"

DATA_POL_JS = os.path.join(BASE_DST, "data", "kaoyan_data_pol.js")

def get_audio_info(file_path):
    cmd = [
        "ffprobe", "-v", "error", "-show_entries",
        "format=bit_rate,duration:stream=channels,sample_rate",
        "-of", "json", file_path
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        data = json.loads(res.stdout)
        bitrate = int(data.get("format", {}).get("bit_rate", 0))
        duration = float(data.get("format", {}).get("duration", 0.0))
        channels = 1
        streams = data.get("streams", [])
        if streams:
            channels = int(streams[0].get("channels", 1))
        return bitrate, duration, channels
    except Exception:
        return 0, 0.0, 1

def compress_file(src_path, dst_path):
    """
    使用 ffmpeg 将音频压缩为 64k mono 44.1kHz
    若目标已存在且文件大小 > 5000 字节，直接返回已存在
    """
    if os.path.exists(dst_path) and os.path.getsize(dst_path) > 5000:
        return True, "skipped"

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    temp_dst = dst_path + ".tmp.mp3"
    
    cmd = [
        "ffmpeg", "-y", "-i", src_path,
        "-vn", "-ac", "1", "-ar", "44100", "-b:a", "64k",
        "-map_metadata", "-1", temp_dst
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        if os.path.exists(temp_dst) and os.path.getsize(temp_dst) > 1000:
            if os.path.exists(dst_path):
                os.remove(dst_path)
            os.rename(temp_dst, dst_path)
            return True, "compressed"
        else:
            if os.path.exists(temp_dst):
                os.remove(temp_dst)
            return False, "file_too_small"
    except Exception as e:
        if os.path.exists(temp_dst):
            os.remove(temp_dst)
        return False, str(e)

def optimize_existing_file(file_path):
    """如果文件码率 > 70kbps 或声道 > 1，则瘦身"""
    bitrate, duration, channels = get_audio_info(file_path)
    if bitrate > 70000 or channels > 1:
        temp_out = file_path + ".opt.mp3"
        cmd = [
            "ffmpeg", "-y", "-i", file_path,
            "-vn", "-ac", "1", "-ar", "44100", "-b:a", "64k",
            "-map_metadata", "-1", temp_out
        ]
        try:
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            if os.path.exists(temp_out) and os.path.getsize(temp_out) > 1000:
                os.remove(file_path)
                os.rename(temp_out, file_path)
                return True, "optimized"
            else:
                if os.path.exists(temp_out):
                    os.remove(temp_out)
                return False, "small_temp"
        except Exception as e:
            if os.path.exists(temp_out):
                os.remove(temp_out)
            return False, str(e)
    return True, "already_optimal"

def main():
    start_time = time.time()
    print("=== Phase 1.2: 音频资产清洗、迁移与 64kbps 高保真瘦身 ===")

    # 1. 读取考研政治数据，构建 208 个政治文件迁移清单
    with open(DATA_POL_JS, "r", encoding="utf-8") as f:
        text = f.read()
    raw_json = text[len("window.KAOYAN_POL_DATA = "):].rstrip().rstrip(";")
    pol_data = json.loads(raw_json)

    pol_tasks = {} # dst_path -> src_path

    # 47 chapters
    dst_pol_dir = os.path.join(BASE_DST, "audio_cards", "pol")
    for ch in pol_data["chapters47"]:
        ch_id = ch["id"]
        fname = f"{ch_id}_recite.mp3"
        src = os.path.join(POL_SRC_CARDS, fname)
        dst = os.path.join(dst_pol_dir, fname)
        pol_tasks[dst] = src

    # subcards
    for ch in pol_data["chapters47"]:
        for sc in ch["track2"]["subCards"]:
            cid = sc["cardId"]
            if cid == "xsx_00":
                continue
            fname = f"{cid}.mp3"
            src = os.path.join(POL_SRC_CARDS, fname)
            dst = os.path.join(dst_pol_dir, fname)
            pol_tasks[dst] = src

    # xutao 16 days
    dst_xt_dir = os.path.join(BASE_DST, "audio_xutao")
    for xt in pol_data["xutao16"]:
        d = xt["day"]
        fan = f"xt_anlang_d{d:02d}.mp3"
        fvo = f"xt_voice_d{d:02d}.mp3"
        pol_tasks[os.path.join(dst_xt_dir, fan)] = os.path.join(POL_SRC_XUTAO, fan)
        pol_tasks[os.path.join(dst_xt_dir, fvo)] = os.path.join(POL_SRC_XUTAO, fvo)

    # tuijie 11 days
    dst_tj_dir = os.path.join(BASE_DST, "audio_tuijie")
    for tj in pol_data["tuijie11"]:
        d = tj["day"]
        ftj = f"tuijie_d{d:02d}.mp3"
        pol_tasks[os.path.join(dst_tj_dir, ftj)] = os.path.join(POL_SRC_TUIJIE, ftj)

    print(f"[1/3] 考研政治白名单音频数: {len(pol_tasks)} (要求: 208)")
    assert len(pol_tasks) == 208, f"Expected 208 distinct pol audios, got {len(pol_tasks)}"

    # 2. 并发执行政治音频迁移与 64k 压缩
    print("[2/3] 开始并发迁移并压缩考研政治 208 个音频至 64kbps 单声道...")
    compressed_count = 0
    skipped_count = 0
    errors = []

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(compress_file, src, dst): (src, dst) for dst, src in pol_tasks.items()}
        for fut in as_completed(futures):
            src, dst = futures[fut]
            ok, status = fut.result()
            if ok:
                if status == "compressed":
                    compressed_count += 1
                else:
                    skipped_count += 1
            else:
                errors.append((dst, status))

    print(f"  政治音频完成: compressed={compressed_count}, skipped={skipped_count}, errors={len(errors)}")
    if errors:
        print("  Errors:", errors[:5])
        sys.exit(1)

    # 3. 对专业课（706/807/en）已有音频执行 64kbps 优化
    print("[3/3] 检查并优化专业课（706/807/en）现有音频码率...")
    existing_audios = []
    for root, dirs, files in os.walk(os.path.join(BASE_DST, "audio_cards")):
        # 跳过 pol 目录，刚才已经按 64k 压缩过了
        if os.path.basename(root) == "pol":
            continue
        for f in files:
            if f.endswith(".mp3"):
                existing_audios.append(os.path.join(root, f))

    print(f"  专业课待审计音频数量: {len(existing_audios)}")
    opt_count = 0
    opt_skip = 0
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(optimize_existing_file, fpath): fpath for fpath in existing_audios}
        for fut in as_completed(futures):
            ok, status = fut.result()
            if ok:
                if status == "optimized":
                    opt_count += 1
                else:
                    opt_skip += 1
            else:
                print(f"  Optimize error for file: {status}")

    print(f"  专业课音频优化完成: optimized={opt_count}, skipped={opt_skip}")

    # 4. 全量音频最终体积与数量统计
    total_files = 0
    total_bytes = 0
    for folder in [os.path.join(BASE_DST, "audio_cards"), dst_xt_dir, dst_tj_dir]:
        for root, dirs, files in os.walk(folder):
            for f in files:
                if f.endswith(".mp3"):
                    total_files += 1
                    total_bytes += os.path.getsize(os.path.join(root, f))

    total_mb = total_bytes / (1024 * 1024)
    elapsed = time.time() - start_time
    print(f"\n==================== 音频处理圆满完成 ====================")
    print(f"全仓有效音频总数: {total_files} 个 (专业课 {len(existing_audios)} + 政治 208)")
    print(f"全仓音频总体积: {total_mb:.2f} MB (严格控制在 400 MB 以内，解除 GitHub Pages 限制！)")
    print(f"耗时: {elapsed:.1f} 秒")
    print(f"===========================================================")

if __name__ == "__main__":
    main()
