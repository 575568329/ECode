import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectImageType,
  readImageFromFile,
  extractImagePaths,
  IMAGE_EXTENSION_REGEX,
} from '../src/image.js';

// ---- 测试用图片 buffer 构造（真实 magic bytes）----

/** 构造最小合法 PNG buffer（8 字节签名即可被 magic bytes 识别） */
function makePngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/** 构造最小 JPEG buffer（3 字节签名） */
function makeJpegBuffer(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
}

/** 构造最小 GIF buffer（6 字节签名 + 版本） */
function makeGifBuffer(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
}

/** 构造最小 WebP buffer（12 字节 RIFF....WEBP） */
function makeWebpBuffer(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(0, 4); // 文件大小占位
  buf.write('WEBP', 8);
  return buf;
}

/** 构造非图片 buffer（纯文本内容） */
function makeTextBuffer(): Buffer {
  return Buffer.from('This is not an image file.');
}

// ---- 临时文件管理 ----

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ecode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// detectImageType
// ============================================================

describe('detectImageType', () => {
  it('PNG magic bytes → image/png', () => {
    expect(detectImageType(makePngBuffer())).toBe('image/png');
  });

  it('JPEG magic bytes → image/jpeg', () => {
    expect(detectImageType(makeJpegBuffer())).toBe('image/jpeg');
  });

  it('GIF magic bytes → image/gif', () => {
    expect(detectImageType(makeGifBuffer())).toBe('image/gif');
  });

  it('WebP magic bytes → image/webp', () => {
    expect(detectImageType(makeWebpBuffer())).toBe('image/webp');
  });

  it('非图片内容 → null', () => {
    expect(detectImageType(makeTextBuffer())).toBeNull();
  });

  it('空 buffer → null', () => {
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });

  it('过短 buffer（仅 1 字节）→ null', () => {
    expect(detectImageType(Buffer.from([0x89]))).toBeNull();
  });
});

// ============================================================
// readImageFromFile
// ============================================================

describe('readImageFromFile', () => {
  it('正常读 PNG → 返回 base64 + mediaType', () => {
    const pngPath = join(tmpDir, 'test.png');
    const pngBuf = makePngBuffer();
    writeFileSync(pngPath, pngBuf);

    const result = readImageFromFile(pngPath);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('base64');
    expect(result!.mediaType).toBe('image/png');
    expect(result!.data).toBe(pngBuf.toString('base64'));
  });

  it('正常读 JPEG → 返回 base64 + mediaType', () => {
    const jpegPath = join(tmpDir, 'photo.jpeg');
    const jpegBuf = makeJpegBuffer();
    writeFileSync(jpegPath, jpegBuf);

    const result = readImageFromFile(jpegPath);
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/jpeg');
    expect(result!.data).toBe(jpegBuf.toString('base64'));
  });

  it('正常读 GIF → 返回 base64 + mediaType', () => {
    const gifPath = join(tmpDir, 'anim.gif');
    const gifBuf = makeGifBuffer();
    writeFileSync(gifPath, gifBuf);

    const result = readImageFromFile(gifPath);
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/gif');
  });

  it('正常读 WebP → 返回 base64 + mediaType', () => {
    const webpPath = join(tmpDir, 'image.webp');
    const webpBuf = makeWebpBuffer();
    writeFileSync(webpPath, webpBuf);

    const result = readImageFromFile(webpPath);
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/webp');
  });

  it('扩展名是 .png 但内容不是图片 → null（magic bytes 优先）', () => {
    const fakePath = join(tmpDir, 'fake.png');
    writeFileSync(fakePath, makeTextBuffer());

    expect(readImageFromFile(fakePath)).toBeNull();
  });

  it('文件不存在 → null', () => {
    expect(readImageFromFile(join(tmpDir, 'nonexistent.png'))).toBeNull();
  });

  it('相对路径基于 cwd 参数解析', () => {
    const pngPath = join(tmpDir, 'relative.png');
    const pngBuf = makePngBuffer();
    writeFileSync(pngPath, pngBuf);

    // 传 tmpDir 作为 cwd，用相对文件名
    const result = readImageFromFile('relative.png', tmpDir);
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/png');
  });

  it('超大文件（超过 20MB 限制）→ null', () => {
    const bigPath = join(tmpDir, 'big.png');
    // 写一个合法 PNG 头 + 大量填充数据（超过 20MB）
    const header = makePngBuffer();
    const padding = Buffer.alloc(21 * 1024 * 1024, 0x00);
    writeFileSync(bigPath, Buffer.concat([header, padding]));

    expect(readImageFromFile(bigPath)).toBeNull();
  });
});

// ============================================================
// extractImagePaths
// ============================================================

describe('extractImagePaths', () => {
  it('从混合文本提取单个绝对路径', () => {
    const text = '看下这个图片 D:\\test\\screenshot.png';
    expect(extractImagePaths(text)).toEqual(['D:\\test\\screenshot.png']);
  });

  it('从混合文本提取 Unix 绝对路径', () => {
    const text = '检查 /home/user/images/photo.jpeg';
    expect(extractImagePaths(text)).toEqual(['/home/user/images/photo.jpeg']);
  });

  it('提取相对路径（./ 前缀）', () => {
    const text = '看 ./screenshot.png 这个';
    expect(extractImagePaths(text)).toEqual(['./screenshot.png']);
  });

  it('提取多个图片路径', () => {
    const text = '对比 a.png 和 b.jpeg 两张图';
    expect(extractImagePaths(text)).toEqual(['a.png', 'b.jpeg']);
  });

  it('提取被引号包裹的路径（双引号）', () => {
    const text = '看这个 "C:\\Users\\test\\image.png"';
    expect(extractImagePaths(text)).toEqual(['C:\\Users\\test\\image.png']);
  });

  it('提取被单引号包裹的路径', () => {
    const text = "看 '/tmp/test.gif' 这个";
    expect(extractImagePaths(text)).toEqual(['/tmp/test.gif']);
  });

  it('支持各种扩展名（png/jpg/jpeg/gif/webp）', () => {
    const text = 'a.png b.jpg c.jpeg d.gif e.webp';
    const paths = extractImagePaths(text);
    expect(paths).toHaveLength(5);
    expect(paths).toContain('a.png');
    expect(paths).toContain('b.jpg');
    expect(paths).toContain('c.jpeg');
    expect(paths).toContain('d.gif');
    expect(paths).toContain('e.webp');
  });

  it('扩展名大小写不敏感（.PNG .JPG）', () => {
    const text = '看 screen.PNG 和 photo.JPG';
    expect(extractImagePaths(text)).toEqual(['screen.PNG', 'photo.JPG']);
  });

  it('无图片路径 → 空数组', () => {
    expect(extractImagePaths('这是一段普通文本，没有图片')).toEqual([]);
  });

  it('重复路径去重', () => {
    const text = '看 a.png 和 a.png';
    expect(extractImagePaths(text)).toEqual(['a.png']);
  });

  it('IMAGE_EXTENSION_REGEX 正则匹配基础验证', () => {
    expect(IMAGE_EXTENSION_REGEX.test('test.png')).toBe(true);
    expect(IMAGE_EXTENSION_REGEX.test('test.jpeg')).toBe(true);
    expect(IMAGE_EXTENSION_REGEX.test('test.txt')).toBe(false);
  });
});
