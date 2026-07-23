import type { RhToolboxManifest } from '../utils/rhToolbox';

/**
 * RH工具箱运行 manifest。
 *
 * 维护规则：
 * - 用户包只读取这里的运行配置，不提供客户端编辑入口。
 * - 新增工具优先只新增 manifest，不给节点组件写专属分支。
 * - 启用工具必须填写 webappId、输入映射、输出协议和运行参数。
 * - 制作器保存的持久应用会由 scripts/sync-rh-toolbox-manifest.cjs 在打包检查前合并进这里。
 */
export const RH_TOOLBOX_MANIFEST: RhToolboxManifest = {
  "schema": "t8-rh-toolbox-manifest",
  "version": 1,
  "updatedAt": "2026-07-23T11:09:55.033Z",
  "categories": [
    {
      "id": "custom-rh-tools",
      "name": "抠图",
      "parentId": "image",
      "description": "抠图 RunningHub 工具",
      "order": 50,
      "icon": "Wrench"
    },
    {
      "id": "video-category-fwv2n",
      "name": "图生视频",
      "parentId": "video",
      "description": "图生视频 RunningHub 工具",
      "icon": "Wrench",
      "order": 50
    },
    {
      "id": "image-category-d5zwl",
      "name": "图像编辑",
      "parentId": "image",
      "description": "图像编辑 RunningHub 工具",
      "icon": "Wrench",
      "order": 60
    },
    {
      "id": "video-category-e2v4g",
      "name": "文生视频",
      "parentId": "video",
      "description": "文生视频 RunningHub 工具",
      "icon": "Wrench",
      "order": 60
    },
    {
      "id": "image-category-remove-subject",
      "name": "消除主体",
      "parentId": "image",
      "description": "消除图像主体 RunningHub 工具",
      "icon": "Wrench",
      "order": 65
    },
    {
      "id": "image-category-e78o2",
      "name": "电商",
      "parentId": "image",
      "description": "电商 RunningHub 工具",
      "icon": "Wrench",
      "order": 70
    },
    {
      "id": "video-category-6djrs",
      "name": "视频去水印",
      "parentId": "video",
      "description": "视频去水印 RunningHub 工具",
      "order": 70,
      "icon": "Wrench"
    },
    {
      "id": "image-category-e7but",
      "name": "扩图",
      "parentId": "image",
      "description": "扩图 RunningHub 工具",
      "order": 80,
      "icon": "Wrench"
    },
    {
      "id": "video-category-9d33p",
      "name": "视频超分",
      "parentId": "video",
      "description": "视频超分 RunningHub 工具",
      "order": 80,
      "icon": "Wrench"
    },
    {
      "id": "video-category-9dael",
      "name": "视频抠像",
      "parentId": "video",
      "description": "视频抠像 RunningHub 工具",
      "order": 90,
      "icon": "Wrench"
    },
    {
      "id": "image-category-8h6ed",
      "name": "移除主体",
      "parentId": "image",
      "description": "移除主体 RunningHub 工具",
      "order": 90,
      "icon": "Wrench"
    }
  ],
  "tools": [
    {
      "id": "image-cutout-v1",
      "title": "高清抠图",
      "description": "支持4K高清抠图",
      "categoryId": "custom-rh-tools",
      "webappId": "2066002530877927426",
      "enabled": true,
      "order": 10,
      "capabilities": [
        "image.cutout",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-image",
          "label": "image",
          "kind": "image",
          "rhNodeId": "46",
          "fieldName": "image",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Scissors",
        "showInNode": true,
        "showInImageEditor": true
      }
    },
    {
      "id": "image-upscale-4k",
      "title": "高清放大4K",
      "description": "调用 RH 高清放大4K 能力，保持原图比例输出 4K 高清图",
      "categoryId": "image-category-d5zwl",
      "webappId": "2066353965784199169",
      "enabled": true,
      "order": 15,
      "capabilities": [
        "image.upscale",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-image",
          "label": "image",
          "kind": "image",
          "rhNodeId": "5",
          "fieldName": "image",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "instanceType": "plus",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Maximize2",
        "showInNode": true,
        "showInImageEditor": true
      }
    },
    {
      "id": "tuantiquv10",
      "title": "图案提取V10",
      "description": "图案提取V10",
      "categoryId": "image-category-e78o2",
      "webappId": "2034251740148666369",
      "enabled": true,
      "order": 20,
      "capabilities": [
        "image.cutout",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-image",
          "label": "加载图像",
          "kind": "image",
          "rhNodeId": "39",
          "fieldName": "image",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [
        {
          "key": "node-22-aspect_ratio",
          "label": "比例选择/自定义",
          "kind": "select",
          "rhNodeId": "22",
          "fieldName": "aspect_ratio",
          "defaultValue": "custom",
          "options": [
            "custom",
            "1:1 square 1024x1024",
            "3:4 portrait 896x1152",
            "5:8 portrait 832x1216",
            "9:16 portrait 768x1344",
            "9:21 portrait 640x1536",
            "4:3 landscape 1152x896",
            "3:2 landscape 1216x832",
            "16:9 landscape 1344x768",
            "21:9 landscape 1536x640"
          ]
        },
        {
          "key": "node-22-width",
          "label": "自定义(宽)",
          "kind": "number",
          "rhNodeId": "22",
          "fieldName": "width",
          "defaultValue": 672
        },
        {
          "key": "node-22-height",
          "label": "自定义(高)",
          "kind": "number",
          "rhNodeId": "22",
          "fieldName": "height",
          "defaultValue": 1200
        },
        {
          "key": "node-41-seed",
          "label": "随机种",
          "kind": "number",
          "rhNodeId": "41",
          "fieldName": "seed",
          "defaultValue": 878536407901947
        }
      ],
      "runtime": {
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wand2",
        "showInNode": true,
        "showInImageEditor": true
      }
    },
    {
      "id": "bernini1",
      "title": "Bernini图生视频+音效(720P)",
      "description": "Bernini图生视频+音效",
      "categoryId": "video-category-fwv2n",
      "webappId": "2064192352843034626",
      "enabled": true,
      "order": 30,
      "capabilities": [
        "video.edit"
      ],
      "inputSchema": [
        {
          "key": "text",
          "label": "text",
          "kind": "text",
          "rhNodeId": "410",
          "fieldName": "text",
          "required": false,
          "defaultValue": "女人运球灌篮",
          "uploadAsset": false,
          "order": 0
        },
        {
          "key": "source-image",
          "label": "image",
          "kind": "image",
          "rhNodeId": "408",
          "fieldName": "image",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 1
        }
      ],
      "outputSchema": [
        {
          "key": "output-video",
          "label": "输出视频",
          "kind": "video",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [
        {
          "key": "node-390-value",
          "label": "总帧数",
          "kind": "number",
          "rhNodeId": "390",
          "fieldName": "value",
          "defaultValue": 129
        },
        {
          "key": "node-417-value",
          "label": "最长边",
          "kind": "number",
          "rhNodeId": "417",
          "fieldName": "value",
          "defaultValue": 1280
        }
      ],
      "runtime": {
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Video",
        "showInNode": true,
        "showInVideoEditor": true
      }
    },
    {
      "id": "berninituxiangbianji",
      "title": "bernini图像编辑",
      "description": "bernini图像编辑",
      "categoryId": "image-category-d5zwl",
      "webappId": "2064222937024131073",
      "enabled": true,
      "order": 40,
      "capabilities": [
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-image",
          "label": "image",
          "kind": "image",
          "rhNodeId": "361",
          "fieldName": "image",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        },
        {
          "key": "text",
          "label": "text",
          "kind": "text",
          "rhNodeId": "364",
          "fieldName": "text",
          "required": false,
          "defaultValue": "这个女人在操场打篮球，上篮",
          "uploadAsset": false,
          "order": 1
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [
        {
          "key": "node-370-value",
          "label": "最长边",
          "kind": "number",
          "rhNodeId": "370",
          "fieldName": "value",
          "defaultValue": 1280
        }
      ],
      "runtime": {
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Image",
        "showInNode": true,
        "showInImageEditor": true
      }
    },
    {
      "id": "bernini2",
      "title": "Bernini文生视频+音效(720P)",
      "description": "Bernini文生视频+音效",
      "categoryId": "video-category-e2v4g",
      "webappId": "2064185875537420290",
      "enabled": true,
      "order": 50,
      "capabilities": [
        "video.edit"
      ],
      "inputSchema": [
        {
          "key": "text",
          "label": "text",
          "kind": "text",
          "rhNodeId": "210",
          "fieldName": "text",
          "required": false,
          "defaultValue": "悟空和沙鲁对战",
          "uploadAsset": false,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-video",
          "label": "输出视频",
          "kind": "video",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [
        {
          "key": "node-191-value",
          "label": "总帧数",
          "kind": "number",
          "rhNodeId": "191",
          "fieldName": "value",
          "defaultValue": 129
        },
        {
          "key": "node-212-value",
          "label": "宽度",
          "kind": "number",
          "rhNodeId": "212",
          "fieldName": "value",
          "defaultValue": 1280
        },
        {
          "key": "node-213-value",
          "label": "高度",
          "kind": "number",
          "rhNodeId": "213",
          "fieldName": "value",
          "defaultValue": 720
        }
      ],
      "runtime": {
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Video",
        "showInNode": true,
        "showInVideoEditor": true
      }
    },
    {
      "id": "jimenfenshen1",
      "title": "即梦分身去水印（手机版）",
      "description": "即梦分身去水印（手机版）",
      "categoryId": "video-category-6djrs",
      "webappId": "2027300825827123202",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "image.cutout",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-video",
          "label": "video",
          "kind": "video",
          "rhNodeId": "205",
          "fieldName": "video",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "instanceType": "plus",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wrench",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": false,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    },
    {
      "id": "kuotu-1",
      "title": "扩图",
      "description": "扩图",
      "categoryId": "image-category-e7but",
      "webappId": "2066227901946748930",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "image.cutout",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-image",
          "label": "image",
          "kind": "image",
          "rhNodeId": "5",
          "fieldName": "image",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [
        {
          "key": "node-105",
          "label": "选择尺寸",
          "kind": "select",
          "rhNodeId": "105",
          "fieldName": "选择尺寸",
          "defaultValue": "16：9（1392x752）",
          "placeholder": "",
          "options": [
            "原始比例",
            "1：1（1024x1024）",
            "1：2（720x1456）",
            "2：3（832x1248）",
            "3：4（880x1184）",
            "3：5（800x1328）",
            "9：16（752x1392）",
            "9：21（672x1568）",
            "2：1（1456x720）",
            "3：2（1248x832）",
            "4：3（1184x880）",
            "5：3（1328x800）",
            "16：9（1392x752）",
            "21：9（1568x672）"
          ],
          "required": false
        }
      ],
      "runtime": {
        "instanceType": "",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wrench",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": false,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    },
    {
      "id": "video-removebg-v1",
      "title": "视频抠像",
      "description": "视频抠像",
      "categoryId": "video-category-9dael",
      "webappId": "2036113391479169025",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "video.cutout",
        "video.edit"
      ],
      "inputSchema": [
        {
          "key": "prompt",
          "label": "分割提示词",
          "kind": "text",
          "rhNodeId": "53",
          "fieldName": "prompt",
          "required": false,
          "multiple": false,
          "defaultValue": "男人",
          "uploadAsset": false,
          "order": 0
        },
        {
          "key": "source-video",
          "label": "video",
          "kind": "video",
          "rhNodeId": "51",
          "fieldName": "video",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 1
        }
      ],
      "outputSchema": [
        {
          "key": "output-video",
          "label": "输出视频",
          "kind": "video",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [
        {
          "key": "node-51-skip_first_frames",
          "label": "跳过帧",
          "kind": "number",
          "rhNodeId": "51",
          "fieldName": "skip_first_frames",
          "defaultValue": "0",
          "placeholder": "",
          "required": false
        },
        {
          "key": "node-51-frame_load_cap",
          "label": "读取帧",
          "kind": "number",
          "rhNodeId": "51",
          "fieldName": "frame_load_cap",
          "defaultValue": "0",
          "placeholder": "",
          "required": false
        },
        {
          "key": "node-56-value",
          "label": "缩放长边",
          "kind": "number",
          "rhNodeId": "56",
          "fieldName": "value",
          "defaultValue": "960",
          "placeholder": "",
          "required": false
        }
      ],
      "runtime": {
        "instanceType": "plus",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Scissors",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": true,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    },
    {
      "id": "xiaochuzhuti",
      "title": "消除主体",
      "description": "消除主体",
      "categoryId": "image-category-8h6ed",
      "webappId": "2067098822521745410",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "image.cutout",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-image",
          "label": "image",
          "kind": "image",
          "rhNodeId": "44",
          "fieldName": "image",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "instanceType": "",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wrench",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": false,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    },
    {
      "id": "xiaoyunqueheng",
      "title": "小云雀视频去水印（横版）",
      "description": "小云雀视频去水印（横版）",
      "categoryId": "video-category-6djrs",
      "webappId": "2020109251271725058",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "image.cutout",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-video",
          "label": "video",
          "kind": "video",
          "rhNodeId": "205",
          "fieldName": "video",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "instanceType": "plus",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wrench",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": false,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    },
    {
      "id": "xiaoyunqueshu",
      "title": "小云雀视频去水印（竖版）",
      "description": "小云雀视频去水印（竖版）",
      "categoryId": "video-category-6djrs",
      "webappId": "2020114992531513345",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "image.cutout",
        "image.edit"
      ],
      "inputSchema": [
        {
          "key": "source-video",
          "label": "video",
          "kind": "video",
          "rhNodeId": "205",
          "fieldName": "video",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-image",
          "label": "输出图",
          "kind": "image",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "instanceType": "plus",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wrench",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": false,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    },
    {
      "id": "video-nividia-upscale",
      "title": "英伟达极速超分",
      "description": "英伟达极速超分",
      "categoryId": "video-category-9d33p",
      "webappId": "2032095665941123073",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "video.upscale",
        "video.edit"
      ],
      "inputSchema": [
        {
          "key": "source-video",
          "label": "video",
          "kind": "video",
          "rhNodeId": "3",
          "fieldName": "video",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-video",
          "label": "输出视频",
          "kind": "video",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "instanceType": "plus",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wrench",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": true,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    },
    {
      "id": "video-flashvsr",
      "title": "FlashVsr慢速超分",
      "description": "FlashVsr慢速超分",
      "categoryId": "video-category-9d33p",
      "webappId": "2043165928090767362",
      "rhSite": "cn",
      "enabled": true,
      "order": 100,
      "capabilities": [
        "video.upscale",
        "video.edit"
      ],
      "inputSchema": [
        {
          "key": "source-video",
          "label": "file",
          "kind": "video",
          "rhNodeId": "9",
          "fieldName": "file",
          "required": true,
          "multiple": false,
          "uploadAsset": true,
          "order": 0
        }
      ],
      "outputSchema": [
        {
          "key": "output-video",
          "label": "输出视频",
          "kind": "video",
          "role": "append-output"
        }
      ],
      "fixedParams": [],
      "userParams": [],
      "runtime": {
        "instanceType": "plus",
        "pollIntervalMs": 5000,
        "maxPolls": 720,
        "fetchAppInfo": true
      },
      "ui": {
        "icon": "Wrench",
        "showInNode": true,
        "showInImageEditor": false,
        "showInVideoEditor": true,
        "showInTextEditor": false,
        "showInAudioEditor": false
      },
      "version": 1
    }
  ]
};
