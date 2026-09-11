// synteeBridge — RPC-мост с процессом плагина (postMessage-протокол).
// Документация: plugin_docs(section=ui).
const synteeBridge = (() => {
  let seq = 0
  const pending = new Map()
  const handlers = new Map()
  window.addEventListener("message", (e) => {
    const d = e.data
    if (!d || d.source !== "syntee-plugin-host") return
    if (d.rpc && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id)
      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || "RPC error"))
      return
    }
    if (d.theme) { document.documentElement.dataset.dark = d.theme.dark ? "1" : "0"; return }
    // Push от плагина (ui.emit) приходит обёрнутым в { __rpc__: true, method, data }.
    if (d.data && d.data.__rpc__) {
      ;(handlers.get(d.data.method) || []).forEach(cb => { try { cb(d.data.data) } catch (err) { console.error(err) } })
      return
    }
    if (d.data !== undefined) {
      ;(handlers.get("*") || []).forEach(cb => { try { cb(d.data) } catch (err) { console.error(err) } })
    }
  })
  return {
    call(method, args) {
      const id = "rpc-" + (++seq)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        parent.postMessage({ source: "syntee-plugin", rpc: true, id, method, args }, "*")
      })
    },
    on(method, cb) {
      if (!handlers.has(method)) handlers.set(method, [])
      handlers.get(method).push(cb)
    },
  }
})()
