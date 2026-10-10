/** omp's plugin sources: marketplace catalogs, git URLs, and its tar reader that refuses links and `..`. */
export { parseGitUrl } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/git-url'
export {
  classifySource,
  parseMarketplaceCatalog,
} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/fetcher'
export {
  isValidNameSegment,
  type MarketplaceCatalog,
  type MarketplacePluginEntry,
} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/types'
export { readTar, writeTar } from '@oh-my-pi/pi-coding-agent/skillshare/tar'
