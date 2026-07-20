import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jimengCli = require('../backend/src/providers/jimengCli.js');

test('Jimeng image generation builds text2image command and extracts returned media', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    imageModels: ['jimeng-image-2k'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateImage(provider, {
    prompt: 'basketball pose',
    model: 'jimeng-image-2k',
    size: '1344x768',
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { images: ['C:\\tmp\\jimeng.png'] };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(commands[0].command, 'dreamina');
  assert.equal(commands[0].args[0], 'text2image');
  assert.ok(commands[0].args.includes('--prompt=basketball pose'));
  assert.ok(commands[0].args.includes('--ratio=16:9'));
  assert.ok(commands[0].args.includes('--resolution_type=2k'));
  assert.ok(commands[0].args.includes('--poll=20'));
  assert.deepEqual(result.imageUrls, ['/files/output/jimeng.png']);
});

test('Jimeng provider test accepts a WSL dreamina executable path', async () => {
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    jimengConfig: {
      executablePath: '/home/administrator/.local/bin/dreamina',
      useWsl: true,
      wslDistro: 'Ubuntu',
    },
  };

  const result = await jimengCli.testProvider(provider, {
    commandExists: async (command: string, candidateProvider: any) => (
      command === '/home/administrator/.local/bin/dreamina'
      && candidateProvider.jimengConfig.useWsl === true
      && candidateProvider.jimengConfig.wslDistro === 'Ubuntu'
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'cli_found');
});

test('Jimeng video generation builds image2video command when one reference image is provided', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0fast_vip'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'run',
    model: 'seedance2.0fast_vip',
    aspect_ratio: '9:16',
    duration: 6,
    resolution: '720p',
    images: ['C:\\tmp\\ref.png'],
    providerParams: { frameMode: 'first' },
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\jimeng.mp4'], submit_id: 'sub-1' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(commands[0].args[0], 'image2video');
  assert.ok(commands[0].args.includes('--image=C:\\tmp\\ref.png'));
  assert.ok(commands[0].args.includes('--model_version=seedance2.0fast_vip'));
  assert.ok(commands[0].args.includes('--video_resolution=720p'));
  assert.ok(commands[0].args.includes('--poll=20'));
  assert.deepEqual(result.videoUrls, ['/files/output/jimeng.mp4']);
  assert.equal(result.taskId, 'sub-1');
});

test('Jimeng video generation accepts non-vip Seedance 2.0 CLI model aliases', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0fast', 'seedance2.0'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'street shot',
    providerModel: 'seedance2.0fast',
    duration: 5,
    resolution: '1080p',
    aspect_ratio: '16:9',
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\seedance-fast.mp4'], submit_id: 'vid-fast' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'seedance2.0fast');
  assert.equal(commands[0].args[0], 'text2video');
  assert.ok(commands[0].args.includes('--model_version=seedance2.0fast'));
  assert.ok(commands[0].args.includes('--video_resolution=720p'));
  assert.deepEqual(result.videoUrls, ['/files/output/seedance-fast.mp4']);
});

test('Jimeng video generation downloads resource URLs to local temp files for CLI input', async () => {
  const commands: any[] = [];
  let fetchedUrl = '';
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0fast_vip'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'resource ref',
    providerModel: 'seedance2.0fast_vip',
    duration: 5,
    resolution: '720p',
    images: ['/api/resources/file/res_1780511970449_o3z00nv1'],
    providerParams: { frameMode: 'first' },
  }, {
    fetchImpl: async (url: string) => {
      fetchedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      };
    },
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\resource.mp4'], submit_id: 'vid-resource' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  const imageArg = commands[0].args.find((arg: string) => arg.startsWith('--image='));
  assert.equal(result.ok, true);
  assert.match(fetchedUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/resources\/file\/res_1780511970449_o3z00nv1$/);
  assert.ok(imageArg);
  assert.notEqual(imageArg, '--image=/api/resources/file/res_1780511970449_o3z00nv1');
  assert.match(String(imageArg), /t8-jimeng-ref-/);
  assert.deepEqual(result.videoUrls, ['/files/output/resource.mp4']);
});

test('Jimeng generation queries async result when CLI only returns submit id', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    imageModels: ['jimeng-image-2k'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateImage(provider, {
    prompt: 'portrait',
    providerModel: 'jimeng-image-2k',
    model: 'legacy-node-model',
    size: '1024x1024',
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args[0] === 'query_result') {
        return { data: { result_json: '{"images":["C:\\\\tmp\\\\done.png"]}' } };
      }
      return { submit_id: 'img-sub-1', gen_status: 'running' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'jimeng-image-2k');
  assert.equal(commands[0].args[0], 'text2image');
  assert.equal(commands[1].args[0], 'query_result');
  assert.ok(commands[1].args.includes('--submit_id=img-sub-1'));
  assert.ok(commands[1].args.some((arg: string) => arg.startsWith('--download_dir=')));
  assert.deepEqual(result.imageUrls, ['/files/output/done.png']);
});

test('Jimeng image generation sends Seedream 4.7 model_version from CLI model option', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    imageModels: ['seedream-4.7'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateImage(provider, {
    prompt: 'product poster',
    providerModel: 'seedream-4.7',
    size: '4096x4096',
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { images: ['C:\\tmp\\seedream47.png'], submit_id: 'img-47' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'seedream-4.7');
  assert.equal(commands[0].args[0], 'text2image');
  assert.ok(commands[0].args.includes('--model_version=4.7'));
  assert.ok(commands[0].args.includes('--resolution_type=4k'));
  assert.deepEqual(result.imageUrls, ['/files/output/seedream47.png']);
});

test('Jimeng image generation passes generate_num for text2image batch output', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    imageModels: ['seedream-4.7'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateImage(provider, {
    prompt: 'ten product angles',
    providerModel: 'seedream-4.7',
    size: '1024x1024',
    n: 12,
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return {
        images: [
          'C:\\tmp\\batch-1.png',
          'C:\\tmp\\batch-2.png',
        ],
      };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(commands[0].args[0], 'text2image');
  assert.ok(commands[0].args.includes('--generate_num=10'));
  assert.deepEqual(result.imageUrls, ['/files/output/batch-1.png', '/files/output/batch-2.png']);
});

test('Jimeng image generation passes generate_num for image2image batch output', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    imageModels: ['seedream-5.0'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateImage(provider, {
    prompt: 'variation set',
    providerModel: 'seedream-5.0',
    size: '2048x2048',
    images: ['C:\\tmp\\ref.png'],
    providerParams: { generate_num: 6 },
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { images: ['C:\\tmp\\edit-1.png'], submit_id: 'img-edit-batch' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(commands[0].args[0], 'image2image');
  assert.ok(commands[0].args.includes('--generate_num=6'));
  assert.deepEqual(result.imageUrls, ['/files/output/edit-1.png']);
});

test('Jimeng Seedance 2.0 VIP can request 4K video resolution', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0_vip'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateVideo(provider, {
    prompt: '4k city flythrough',
    providerModel: 'seedance2.0_vip',
    aspect_ratio: '16:9',
    duration: 8,
    resolution: '4k',
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\vip-4k.mp4'], submit_id: 'vid-4k' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(commands[0].args[0], 'text2video');
  assert.ok(commands[0].args.includes('--model_version=seedance2.0_vip'));
  assert.ok(commands[0].args.includes('--video_resolution=4k'));
});

test('Jimeng video generation supports Seedance 2.0 mini and Seedance 1.x image2video model names', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0mini', 'seedance1.5pro', 'seedance1.0fast', 'seedance1.0'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  await jimengCli.generateVideo(provider, {
    prompt: 'mini model shot',
    providerModel: 'seedance2.0mini',
    aspect_ratio: '16:9',
    duration: 5,
    resolution: '720p',
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\mini.mp4'], submit_id: 'vid-mini' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  await jimengCli.generateVideo(provider, {
    prompt: 'legacy seedance web name',
    providerModel: 'seedance1.5pro',
    aspect_ratio: '16:9',
    duration: 5,
    resolution: '720p',
    images: ['C:\\tmp\\ref-15.png'],
    providerParams: { frameMode: 'first' },
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\seedance15.mp4'], submit_id: 'vid-15' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  await jimengCli.generateVideo(provider, {
    prompt: 'old seedance alias',
    providerModel: '3.0_fast',
    aspect_ratio: '16:9',
    duration: 5,
    resolution: '720p',
    images: ['C:\\tmp\\ref-fast.png'],
    providerParams: { frameMode: 'first' },
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\seedance10fast.mp4'], submit_id: 'vid-10-fast' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.ok(commands[0].args.includes('--model_version=seedance2.0mini'));
  assert.equal(commands[1].args[0], 'image2video');
  assert.ok(commands[1].args.includes('--model_version=seedance1.5pro'));
  assert.equal(commands[2].args[0], 'image2video');
  assert.ok(commands[2].args.includes('--model_version=seedance1.0fast'));
});

test('Jimeng video generation does not pass Seedance 1.x models to unsupported text2video command', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance1.0fast'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'unsupported pure text old model',
    providerModel: 'seedance1.0fast',
    aspect_ratio: '16:9',
    duration: 5,
    resolution: '720p',
  }, {
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\fallback-text.mp4'], submit_id: 'vid-text' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(commands[0].args[0], 'text2video');
  assert.equal(commands[0].args.some((arg: string) => arg.startsWith('--model_version=seedance1.')), false);
  assert.ok(commands[0].args.includes('--video_resolution=720p'));
});

test('Jimeng async video keeps polling until query_result returns downloaded path objects', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0_vip'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  let queryCount = 0;
  const result = await jimengCli.generateVideo(provider, {
    prompt: 'basketball dance',
    providerModel: 'seedance2.0_vip',
    aspect_ratio: '9:16',
    duration: 5,
    resolution: '720p',
    images: ['C:\\tmp\\ref.png'],
  }, {
    pollIntervalMs: 0,
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args[0] === 'query_result') {
        queryCount += 1;
        if (queryCount === 1) {
          return { submit_id: 'vid-sub-2', gen_status: 'querying', result_json: { images: [], videos: [] } };
        }
        return {
          submit_id: 'vid-sub-2',
          gen_status: 'success',
          result_json: {
            images: [],
            videos: [{ path: 'C:\\tmp\\vid-sub-2_video_1.mp4', width: 720, height: 1280 }],
          },
        };
      }
      return { submit_id: 'vid-sub-2', gen_status: 'querying' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(commands.filter((item) => item.args[0] === 'query_result').length, 2);
  assert.deepEqual(result.videoUrls, ['/files/output/vid-sub-2_video_1.mp4']);
});

test('Jimeng async image extracts result_json image path objects', async () => {
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    imageModels: ['jimeng-image-2k'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateImage(provider, {
    prompt: 'portrait',
    providerModel: 'jimeng-image-2k',
    size: '1024x1024',
  }, {
    pollIntervalMs: 0,
    runCli: async (_command: string, args: string[]) => {
      if (args[0] === 'query_result') {
        return {
          submit_id: 'img-sub-2',
          gen_status: 'success',
          result_json: {
            images: [{ path: 'C:\\tmp\\img-sub-2_image_1.png', width: 1024, height: 1024 }],
            videos: [],
          },
        };
      }
      return { submit_id: 'img-sub-2', gen_status: 'querying' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.imageUrls, ['/files/output/img-sub-2_image_1.png']);
});

test('Jimeng video generation sends image video and audio references through multimodal mode', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['jimeng-video-720p'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'dance',
    providerModel: 'jimeng-video-720p',
    model: 'seedance-2-0-fast',
    aspect_ratio: '16:9',
    duration: 5,
    resolution: '720p',
    images: ['C:\\tmp\\ref.png'],
    videos: ['C:\\tmp\\ref.mp4'],
    audios: ['C:\\tmp\\voice.wav'],
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { data: { video_url: 'C:\\tmp\\jimeng.mp4' }, submit_id: 'vid-sub-1' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'jimeng-video-720p');
  assert.equal(commands[0].args[0], 'multimodal2video');
  assert.ok(commands[0].args.includes('--image=C:\\tmp\\ref.png'));
  assert.ok(commands[0].args.includes('--video=C:\\tmp\\ref.mp4'));
  assert.ok(commands[0].args.includes('--audio=C:\\tmp\\voice.wav'));
  assert.ok(commands[0].args.includes('--video_resolution=720p'));
  assert.equal(commands[0].args.some((arg: string) => arg.startsWith('--model_version=')), false);
  assert.deepEqual(result.videoUrls, ['/files/output/jimeng.mp4']);
});

test('Jimeng Seedance video caps multimodal references at 9 images 3 videos and 3 audios', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0fast_vip'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };
  const images = Array.from({ length: 11 }, (_, i) => `C:\\tmp\\image-${i + 1}.png`);
  const videos = Array.from({ length: 5 }, (_, i) => `C:\\tmp\\video-${i + 1}.mp4`);
  const audios = Array.from({ length: 4 }, (_, i) => `C:\\tmp\\audio-${i + 1}.wav`);

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'multi reference action',
    providerModel: 'seedance2.0fast_vip',
    aspect_ratio: '16:9',
    duration: 6,
    resolution: '720p',
    images,
    videos,
    audios,
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\seedance.mp4'], submit_id: 'vid-multi' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  const args = commands[0].args;
  assert.equal(result.ok, true);
  assert.equal(args[0], 'multimodal2video');
  assert.equal(args.filter((arg: string) => arg.startsWith('--image=')).length, 9);
  assert.equal(args.filter((arg: string) => arg.startsWith('--video=')).length, 3);
  assert.equal(args.filter((arg: string) => arg.startsWith('--audio=')).length, 3);
  assert.ok(args.includes('--image=C:\\tmp\\image-9.png'));
  assert.equal(args.some((arg: string) => arg.includes('image-10.png')), false);
  assert.ok(args.includes('--video=C:\\tmp\\video-3.mp4'));
  assert.equal(args.some((arg: string) => arg.includes('video-4.mp4')), false);
  assert.ok(args.includes('--audio=C:\\tmp\\audio-3.wav'));
  assert.equal(args.some((arg: string) => arg.includes('audio-4.wav')), false);
  assert.ok(args.includes('--model_version=seedance2.0fast_vip'));
  assert.deepEqual(result.videoUrls, ['/files/output/seedance.mp4']);
});

test('Jimeng Seedance pure multi-image defaults to all-around multimodal reference', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0_vip'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };
  const images = Array.from({ length: 6 }, (_, i) => `C:\\tmp\\omni-${i + 1}.png`);

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'all around reference action',
    providerModel: 'seedance2.0_vip',
    aspect_ratio: '16:9',
    duration: 6,
    resolution: '720p',
    images,
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\omni.mp4'], submit_id: 'vid-omni' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  const args = commands[0].args;
  assert.equal(result.ok, true);
  assert.equal(args[0], 'multimodal2video');
  assert.equal(args.filter((arg: string) => arg.startsWith('--image=')).length, 6);
  assert.equal(args.some((arg: string) => arg.startsWith('--images=')), false);
  assert.ok(args.includes('--model_version=seedance2.0_vip'));
  assert.ok(args.includes('--video_resolution=720p'));
  assert.deepEqual(result.videoUrls, ['/files/output/omni.mp4']);
});

test('Jimeng Seedance multiframe keeps up to 9 image references', async () => {
  const commands: any[] = [];
  const provider = {
    id: 'jimeng-cli',
    protocol: 'jimeng-cli',
    videoModels: ['seedance2.0_vip'],
    jimengConfig: { executablePath: 'dreamina', pollSeconds: 20 },
  };
  const images = Array.from({ length: 10 }, (_, i) => `C:\\tmp\\frame-${i + 1}.png`);

  const result = await jimengCli.generateVideo(provider, {
    prompt: 'multi frame action',
    providerModel: 'seedance2.0_vip',
    duration: 6,
    resolution: '1080p',
    images,
    providerParams: { frameMode: 'multiframe' },
  }, {
    resolveLocalMedia: async (value: string) => value,
    runCli: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { videos: ['C:\\tmp\\frames.mp4'], submit_id: 'vid-frames' };
    },
    storeOutput: async (value: string) => `/files/output/${value.split('\\').pop()}`,
  });

  const args = commands[0].args;
  const imagesArg = args.find((arg: string) => arg.startsWith('--images='));
  assert.equal(result.ok, true);
  assert.equal(args[0], 'multiframe2video');
  assert.ok(imagesArg);
  assert.equal(String(imagesArg).split(',').length, 9);
  assert.match(String(imagesArg), /frame-9\.png/);
  assert.doesNotMatch(String(imagesArg), /frame-10\.png/);
  assert.equal(args.some((arg: string) => arg.startsWith('--model_version=')), false);
  assert.equal(args.some((arg: string) => arg.startsWith('--video_resolution=')), false);
  assert.equal(args.filter((arg: string) => arg.startsWith('--transition-prompt=')).length, 8);
  assert.equal(args.filter((arg: string) => arg.startsWith('--transition-duration=')).length, 8);
  assert.deepEqual(result.videoUrls, ['/files/output/frames.mp4']);
});
