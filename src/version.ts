import pkg from '../package.json' with { type: 'json' };

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
export const USER_AGENT = `${PACKAGE_NAME}/${VERSION} (+${pkg.homepage})`;
