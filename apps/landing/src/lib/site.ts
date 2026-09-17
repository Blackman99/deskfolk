export const GITHUB_OWNER = 'Blackman99';
export const GITHUB_REPO = 'real-bot';
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_BLOB_MAIN = `${GITHUB_URL}/blob/main`;
export const RELEASES_URL = `${GITHUB_URL}/releases`;
/** Resolves to the newest stable release; while only pre-releases exist GitHub redirects it to the releases list. */
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

/**
 * Canonical origin of the deployed site (GitHub Pages), without a trailing slash.
 * Used for absolute URLs in Open Graph tags, the sitemap and robots.txt.
 * Change this if the landing moves to a custom domain.
 */
export const SITE_URL = `https://${GITHUB_OWNER.toLowerCase()}.github.io/${GITHUB_REPO}`;

export const SITE_NAME = 'Real Bot';

/** Open Graph image size (static/og-zh.png and static/og-en.png). */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
