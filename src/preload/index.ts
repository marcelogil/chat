import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BridgeApi, PushMessage } from '@shared/bridge'

// The entire renderer↔main surface. ipcRenderer itself is never exposed;
// channel names stay internal to this file.

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const bridge: BridgeApi = {
  platform: process.platform as BridgeApi['platform'],
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },

  onPush(cb: (msg: PushMessage) => void) {
    const listener = (_e: unknown, msg: PushMessage) => cb(msg)
    ipcRenderer.on('push', listener)
    return () => ipcRenderer.removeListener('push', listener)
  },

  app: {
    getBoot: () => invoke('app:getBoot'),
    unlock: (passphrase) => invoke('app:unlock', passphrase),
    resetLocalData: () => invoke('app:resetLocalData'),
    changeTeamFolder: () => invoke('app:changeTeamFolder'),
    relaunch: () => invoke('app:relaunch'),
    openExternal: (url) => invoke('app:openExternal', url),
    copyText: (text) => invoke('app:copyText', text),
    showInFolder: (path) => invoke('app:showInFolder', path),
    setBadge: (count) => invoke('app:setBadge', count),
    openAppsFolder: () => invoke('app:openAppsFolder'),
    setFullScreen: (on) => invoke('app:setFullScreen', on),
    isFullScreen: () => invoke('app:isFullScreen'),
    launchInfo: () => invoke('app:launchInfo'),
    setOpenAtLogin: (on) => invoke('app:setOpenAtLogin', on),
    testNotification: () => invoke('app:testNotification'),
  },

  onboarding: {
    pickFolder: () => invoke('onboard:pickFolder'),
    healthCheck: (path) => invoke('onboard:healthCheck', path),
    detectDevice: () => invoke('onboard:detectDevice'),
    submit: (cfg) => invoke('onboard:submit', cfg),
  },

  chat: {
    channels: () => invoke('chat:channels'),
    createChannel: (name, topic) => invoke('chat:createChannel', name, topic),
    dmFor: (peer) => invoke('chat:dmFor', peer),
    events: (conv) => invoke('chat:events', conv),
    send: (conv, draft) => invoke('chat:send', conv, draft),
    edit: (conv, target, text) => invoke('chat:edit', conv, target, text),
    remove: (conv, target) => invoke('chat:remove', conv, target),
    react: (conv, target, emoji, op) => invoke('chat:react', conv, target, emoji, op),
    pin: (conv, target, op) => invoke('chat:pin', conv, target, op),
    markRead: (conv, stem) => invoke('chat:markRead', conv, stem),
    setTyping: (conv) => invoke('chat:setTyping', conv),
    cursors: (conv) => invoke('chat:cursors', conv),
    myReads: () => invoke('chat:myReads'),
    renameChannel: (conv, name) => invoke('chat:renameChannel', conv, name),
    deleteChannel: (conv) => invoke('chat:deleteChannel', conv),
    vote: (conv, target, choice) => invoke('chat:vote', conv, target, choice),
    closePoll: (conv, target) => invoke('chat:closePoll', conv, target),
  },

  boards: {
    start: (conv, title, boardId) => invoke('boards:start', conv, title, boardId),
    join: (sessionId, conv) => invoke('boards:join', sessionId, conv),
    write: (sessionId, conv, draft) => invoke('boards:write', sessionId, conv, draft),
    leave: (sessionId, conv) => invoke('boards:leave', sessionId, conv),
    end: (sessionId, conv, resultStem) => invoke('boards:end', sessionId, conv, resultStem),
  },

  groups: {
    list: () => invoke('groups:list'),
    create: (name, members) => invoke('groups:create', name, members),
    rename: (conv, name) => invoke('groups:rename', conv, name),
    addMembers: (conv, members) => invoke('groups:addMembers', conv, members),
    removeMember: (conv, member) => invoke('groups:removeMember', conv, member),
    leave: (conv) => invoke('groups:leave', conv),
    remove: (conv) => invoke('groups:remove', conv),
  },

  presence: {
    list: () => invoke('presence:list'),
    self: () => invoke('presence:self'),
    setStatus: (text) => invoke('presence:setStatus', text),
    setAppearState: (state) => invoke('presence:setAppearState', state),
  },

  roster: {
    trust: (deviceId, trust) => invoke('roster:trust', deviceId, trust),
  },

  files: {
    fetchBlob: (blobId, key, name, size) => invoke('files:fetchBlob', blobId, key, name, size),
    saveBlobAs: (blobId, suggestedName) => invoke('files:saveBlobAs', blobId, suggestedName),
    startDrag: (blobId, name) => invoke('files:startDrag', blobId, name),
    pathForFile: (file) => webUtils.getPathForFile(file),
    pickFile: (opts) => invoke('files:pickFile', opts),
    saveBytesAs: (suggestedName, bytes, mime) => invoke('files:saveBytesAs', suggestedName, bytes, mime),
    stageBytes: (name, bytes) => invoke('files:stageBytes', name, bytes),
  },

  beams: {
    send: (peer, filePaths) => invoke('beams:send', peer, filePaths),
    accept: (dropId, savePath) => invoke('beams:accept', dropId, savePath),
    decline: (dropId) => invoke('beams:decline', dropId),
    cancel: (dropId) => invoke('beams:cancel', dropId),
  },

  links: {
    preview: (url) => invoke('links:preview', url),
  },

  gifs: {
    packList: () => invoke('gifs:packList'),
    search: (q) => invoke('gifs:search', q),
  },

  screen: {
    sources: () => invoke('screen:sources'),
    permission: () => invoke('screen:permission'),
    openPermissionSettings: () => invoke('screen:openPermissionSettings'),
    primeSource: (sourceId) => invoke('screen:primeSource', sourceId),
    start: (conv, w, h) => invoke('screen:start', conv, w, h),
    stop: (sessionId, conv) => invoke('screen:stop', sessionId, conv),
    join: (sessionId) => invoke('screen:join', sessionId),
    leave: (sessionId) => invoke('screen:leave', sessionId),
  },

  rtc: {
    send: (signal) => invoke('rtc:send', signal),
    setPollMode: (mode) => invoke('rtc:setPollMode', mode),
  },

  frames: {
    publish: (sessionId, seq, bytes) => invoke('frames:publish', sessionId, seq, bytes),
    watchViewers: (sessionId, on) => invoke('frames:watchViewers', sessionId, on),
  },

  calendar: {
    put: (entry) => invoke('calendar:put', entry),
    remove: (id) => invoke('calendar:remove', id),
  },

  prs: {
    status: () => invoke('prs:status'),
    list: () => invoke('prs:list'),
    refresh: () => invoke('prs:refresh'),
    markSeen: (keys) => invoke('prs:markSeen', keys),
    testConnection: (input) => invoke('prs:testConnection', input),
    listRepos: (input) => invoke('prs:listRepos', input),
    saveConfig: (input) => invoke('prs:saveConfig', input),
    setPersonalToken: (token) => invoke('prs:setPersonalToken', token),
    disconnect: () => invoke('prs:disconnect'),
  },

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },

  update: {
    copyToMachine: () => invoke('update:copyToMachine'),
  },

  diag: {
    shareStats: () => invoke('diag:shareStats'),
  },
}

contextBridge.exposeInMainWorld('bridge', bridge)
