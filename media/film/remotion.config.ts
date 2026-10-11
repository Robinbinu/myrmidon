import { Config } from '@remotion/cli/config'

Config.setEntryPoint('src/index.ts')
// JPEG frames at near-lossless quality: the dark gradients band visibly below ~90.
Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(96)
Config.setOverwriteOutput(true)
Config.setCodec('h264')
Config.setPixelFormat('yuv420p')
