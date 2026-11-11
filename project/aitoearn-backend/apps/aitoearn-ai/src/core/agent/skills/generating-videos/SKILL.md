---
name: generating-videos
description: Generates videos using the configured Seedance or Grok tool. AI视频生成、文生视频、图生视频。
---

# Video Generation

## Model Selection Strategy

For text-to-video with no model specified, use Seedance 2.0 when `generateVideoWithSeedance` is available. It accepts a prompt, a duration of 4–15 seconds, and a supported aspect ratio. State the model in the execution plan.

If the user explicitly requests Grok, use `generateVideoWithGrok`. If Grok is unavailable, report that and ask before switching models. When Seedance is unavailable, use configured Grok for text-to-video. Grok also accepts one reference image for image-to-video.

## Language Rule

Video prompts MUST follow the user's language. If the user writes in Chinese, generate Chinese prompts; if in English, generate English prompts. If the user explicitly requests a specific language, use that language.

## Grok Video Model

| Model | Speed | Quality | Max Duration | Use Case |
|-------|-------|---------|--------------|----------|
| `grok-imagine-video` | Fast | Good | 15s | Grok video and image-to-video |

## Grok Parameters

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `duration` | 1-15 | model default | Video duration in seconds |
| `resolution` | `480p`, `720p` | `720p` | Video resolution |
| `aspectRatio` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3` | `9:16` | Video aspect ratio |
| `imageUrl` | URL | none | Reference image URL for image-to-video |

## Workflow

1. Call the generation tool for the selected model and retain its returned task ID. If submission fails, report the error. Poll only after a task ID is returned.
2. Poll every 30 seconds using `getSeedanceVideoStatus` for Seedance or `getGrokVideoStatus` for Grok.
3. Allow up to 20 minutes for Seedance and 5 minutes for Grok.
4. Save completed output to draft unless the user explicitly asks for media library only.

## Prompt Structure

`[Subject & Background] + [Action] + [Style] + [Camera] + [Atmosphere] + [Audio]`

### Subject & Background

Specify the main focus and environmental context.

Examples:
- "A young woman with long black hair wearing a red dress"
- "White concrete apartment building with organic shapes and lush greenery"

### Action

Describe what the subject is doing.

Examples:
- "walks slowly towards the camera"
- "transforms from liquid to solid"

### Style

Add aesthetic direction.

Examples:
- Film noir
- Surrealism
- Cyberpunk
- 3D cartoon animation
- Cinematic documentary

### Camera

Describe movement and framing.

Examples:
- "slow dolly-in"
- "handheld tracking shot"
- "close-up with shallow depth of field"

### Atmosphere

Describe lighting, color, mood, and setting.

Examples:
- "warm sunset lighting"
- "misty morning atmosphere"
- "high contrast studio lighting"

### Audio

Include useful audio cues when relevant.

Examples:
- "soft ambient city sounds"
- "gentle piano music"
- "footsteps on wet pavement"

## Aspect Ratio Guidance

| Platform / Use | Aspect Ratio |
|----------------|--------------|
| TikTok, Reels, Shorts, mobile social video | `9:16` |
| YouTube landscape, website hero, presentation | `16:9` |
| Profile or square feed asset | `1:1` |
| Portrait-style content | `3:4` or `2:3` |
| Landscape social feed | `4:3` or `3:2` |

## Long Video Strategy

For videos longer than 15 seconds:

1. Split the video into independent 15-second-or-shorter segments.
2. Generate each segment with the selected video tool.
3. Poll every task until complete.
4. Load `editing-videos`.
5. Use the video editing tool to concatenate the completed segments.

Keep prompts visually consistent across segments by repeating subject, style, lighting, camera language, and environment details.
