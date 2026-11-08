/** "coffeefactory.homeroll-demo.testnet" -> "coffeefactory.homeroll…testnet" */
export function truncateMiddle(id: string, head = 17, tail = 7): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
