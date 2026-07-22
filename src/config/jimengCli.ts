import compatibility from '../../backend/src/shared/jimengCliCompatibility.json';

export const JIMENG_CLI_SUPPORTED_VERSION = compatibility.supportedVersion;
export const JIMENG_CLI_RELEASE_DATE = compatibility.releaseDate;
export const JIMENG_CLI_INSTALL_UPDATE_COMMAND = compatibility.installUpdateCommand;
export const JIMENG_CLI_OFFICIAL_GUIDE_URL = compatibility.officialGuideUrl;

export const JIMENG_CLI_LOGIN_COMMANDS = {
  login: 'dreamina login',
  headless: 'dreamina login --headless',
  checkLogin: 'dreamina login checklogin --device_code=<设备码> --poll=30',
  verify: 'dreamina user_credit',
  relogin: 'dreamina relogin',
  logout: 'dreamina logout',
} as const;
