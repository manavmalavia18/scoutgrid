import { acceptDataJob } from './data-query.mjs';

export function buildCombinedTitleFilter(softwareFilter, { includeData = false, negativeFilter = () => true } = {}) {
  return (title) => softwareFilter(title) || (includeData && negativeFilter(title) && acceptDataJob({ title }));
}
