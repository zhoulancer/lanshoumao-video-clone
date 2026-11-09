/**
 * 在浏览器中从视频文件提取帧
 * @param videoFile 视频文件
 * @param frameCount 需要提取的帧数
 * @param onProgress 进度回调
 * @returns 压缩后的 JPEG 帧文件
 */
export interface ExtractedFrames {
  files: File[];
  /** 每一帧在原视频中的时间位置（秒），与 files 一一对应 */
  timestamps: number[];
  /** 视频总时长（秒） */
  duration: number;
}

/**
 * 提取视频帧并同时返回每帧的时间戳（秒）。
 * 有了时间戳，AI 分析才能输出「时间轴」，与台词时间对齐。
 */
export async function extractVideoFramesWithTiming(
  videoFile: File,
  frameCount: number = 8,
  onProgress?: (current: number, total: number) => void
): Promise<ExtractedFrames> {
  return new Promise((resolve, reject) => {
    const targetFrameCount = Number.isFinite(frameCount)
      ? Math.min(30, Math.max(1, Math.round(frameCount)))
      : 8;
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      reject(new Error("Failed to get canvas context"));
      return;
    }

    const frames: File[] = [];
    const timestamps: number[] = [];
    let videoDuration = 0;
    const videoUrl = URL.createObjectURL(videoFile);

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      const size = fitWithin(video.videoWidth, video.videoHeight, 1024);
      canvas.width = size.width;
      canvas.height = size.height;

      const duration = video.duration;
      if (!duration || duration === Infinity) {
        URL.revokeObjectURL(videoUrl);
        reject(new Error("Invalid video duration"));
        return;
      }

      // 计算提取时间点（均匀分布）
      videoDuration = duration;
      const interval = duration / (targetFrameCount + 1);
      let currentFrame = 0;

      const extractFrame = () => {
        if (currentFrame >= targetFrameCount) {
          // 提取完成
          URL.revokeObjectURL(videoUrl);
          resolve({ files: frames, timestamps, duration: videoDuration });
          return;
        }

        const time = interval * (currentFrame + 1);
        video.currentTime = time;
      };

      video.onseeked = () => {
        // 绘制当前帧到 canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) {
            URL.revokeObjectURL(videoUrl);
            reject(new Error("Failed to encode video frame"));
            return;
          }
          frames.push(new File([blob], `frame-${String(currentFrame + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
          // 记录这一帧的真实时间位置（秒）
          timestamps.push(Math.round(interval * (currentFrame + 1) * 10) / 10);
          currentFrame++;
          onProgress?.(currentFrame, targetFrameCount);
          extractFrame();
        }, "image/jpeg", 0.72);
      };

      video.onerror = () => {
        URL.revokeObjectURL(videoUrl);
        reject(new Error("Failed to load video"));
      };

      // 开始提取
      extractFrame();
    };

    video.onerror = () => {
      URL.revokeObjectURL(videoUrl);
      reject(new Error("Failed to load video file"));
    };

    video.src = videoUrl;
  });
}

/**
 * 为图片分析生成尺寸受控的 JPEG 帧。
 */
/** 兼容旧调用：只要帧文件，不要时间戳 */
export async function extractVideoFrameFiles(
  videoFile: File,
  frameCount: number = 8,
  onProgress?: (current: number, total: number) => void
): Promise<File[]> {
  const { files } = await extractVideoFramesWithTiming(videoFile, frameCount, onProgress);
  return files;
}

export async function createImageAnalysisFrame(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const imageUrl = URL.createObjectURL(file);
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const size = fitWithin(image.naturalWidth, image.naturalHeight, 1024);
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(imageUrl);
        reject(new Error("Failed to get canvas context"));
        return;
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(imageUrl);
        if (!blob) {
          reject(new Error("Failed to encode image frame"));
          return;
        }
        resolve(new File([blob], "frame-01.jpg", { type: "image/jpeg" }));
      }, "image/jpeg", 0.72);
    };
    image.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error("Failed to load image"));
    };
    image.src = imageUrl;
  });
}

function fitWithin(width: number, height: number, maxEdge: number) {
  if (!width || !height) return { width: maxEdge, height: maxEdge };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
