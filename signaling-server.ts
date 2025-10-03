// signaling-server.ts 的修改版本

// 房间管理接口
interface Room {
  id: string;
  creator: WebSocket;
  joiner?: WebSocket;
  createdAt: number;
  lastActivity: number;
}

// 信令消息类型
interface SignalingMessage {
  type: string;
  roomId?: string;
  sdp?: string;
  candidate?: any;
  error?: string;
}

// 存储房间信息
const rooms = new Map<string, Room>();
const ROOM_TIMEOUT = 30 * 1000;
const CLEANUP_INTERVAL = 10 * 1000;

// 生成6位数字房间号
function generateRoomId(): string {
  let roomId: string;
  do {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(roomId));
  return roomId;
}

// 清理过期房间
function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TIMEOUT) {
      console.log(`清理过期房间: ${roomId}`);
      if (room.creator.readyState === WebSocket.OPEN) {
        room.creator.close(1000, "房间超时");
      }
      if (room.joiner && room.joiner.readyState === WebSocket.OPEN) {
        room.joiner.close(1000, "房间超时");
      }
      rooms.delete(roomId);
    }
  }
}

// 定期清理任务
setInterval(cleanupExpiredRooms, CLEANUP_INTERVAL);

// 处理信令消息
function handleSignalingMessage(socket: WebSocket, message: SignalingMessage) {
  switch (message.type) {
    case "create_room":
      handleCreateRoom(socket);
      break;
      
    case "join_room":
      if (message.roomId) {
        handleJoinRoom(socket, message.roomId);
      }
      break;
      
    case "webrtc_offer":
      if (message.roomId && message.sdp) {
        forwardToPeer(socket, message.roomId, {
          type: "webrtc_offer",
          sdp: message.sdp
        });
      }
      break;
      
    case "webrtc_answer":
      if (message.roomId && message.sdp) {
        forwardToPeer(socket, message.roomId, {
          type: "webrtc_answer", 
          sdp: message.sdp
        });
      }
      break;
      
    case "ice_candidate":
      if (message.roomId && message.candidate) {
        forwardToPeer(socket, message.roomId, {
          type: "ice_candidate",
          candidate: message.candidate
        });
      }
      break;
      
    case "keepalive":
      // 更新房间活动时间
      for (const room of rooms.values()) {
        if (room.creator === socket || room.joiner === socket) {
          room.lastActivity = Date.now();
          break;
        }
      }
      break;
      
    default:
      socket.send(JSON.stringify({
        type: "error",
        error: "未知的消息类型"
      }));
  }
}

// 处理创建房间
function handleCreateRoom(socket: WebSocket) {
  const roomId = generateRoomId();
  
  rooms.set(roomId, {
    id: roomId,
    creator: socket,
    createdAt: Date.now(),
    lastActivity: Date.now()
  });
  
  console.log(`创建新房间: ${roomId}`);
  
  socket.send(JSON.stringify({
    type: "room_created",
    roomId: roomId
  }));
  
  // 设置房间超时定时器
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && !room.joiner) {
      // 如果30秒内没有人加入，关闭房间
      if (room.creator.readyState === WebSocket.OPEN) {
        room.creator.send(JSON.stringify({
          type: "room_expired"
        }));
        room.creator.close(1000, "房间超时");
      }
      rooms.delete(roomId);
      console.log(`房间 ${roomId} 已超时`);
    }
  }, ROOM_TIMEOUT);
}

// 处理加入房间
function handleJoinRoom(socket: WebSocket, roomId: string) {
  const room = rooms.get(roomId);
  
  if (!room) {
    socket.send(JSON.stringify({
      type: "error",
      error: "房间不存在"
    }));
    return;
  }
  
  if (room.joiner) {
    socket.send(JSON.stringify({
      type: "error", 
      error: "房间已满"
    }));
    return;
  }
  
  // 将用户添加到房间
  room.joiner = socket;
  room.lastActivity = Date.now();
  
  console.log(`用户加入房间: ${roomId}`);
  
  // 通知加入者加入成功
  socket.send(JSON.stringify({
    type: "join_success"
  }));
  
  // 通知房主有用户加入
  if (room.creator.readyState === WebSocket.OPEN) {
    room.creator.send(JSON.stringify({
      type: "peer_joined"
    }));
  }
}

// 转发消息给对等方
function forwardToPeer(sender: WebSocket, roomId: string, message: any) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // 更新房间活动时间
  room.lastActivity = Date.now();
  
  let target: WebSocket | undefined;
  
  if (sender === room.creator) {
    target = room.joiner;
  } else if (sender === room.joiner) {
    target = room.creator;
  }
  
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(message));
  }
}

// WebSocket 连接处理
function handleWebSocket(req: Request): Promise<Response> {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return Promise.resolve(new Response("请求需要升级为 WebSocket", { status: 426 }));
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    console.log("WebSocket 连接已建立");
  };

  socket.onmessage = (event) => {
    try {
      const message: SignalingMessage = JSON.parse(event.data);
      handleSignalingMessage(socket, message);
    } catch (error) {
      console.error("消息解析错误:", error);
      socket.send(JSON.stringify({
        type: "error",
        error: "无效的消息格式"
      }));
    }
  };

  socket.onclose = () => {
    console.log("WebSocket 连接已关闭");
    // 清理断开连接的用户所在的房间
    for (const [roomId, room] of rooms.entries()) {
      if (room.creator === socket || room.joiner === socket) {
        // 通知另一方用户断开连接
        const otherUser = room.creator === socket ? room.joiner : room.creator;
        if (otherUser && otherUser.readyState === WebSocket.OPEN) {
          otherUser.send(JSON.stringify({
            type: "peer_disconnected"
          }));
        }
        
        rooms.delete(roomId);
        console.log(`房间 ${roomId} 已清理`);
        break;
      }
    }
  };

  socket.onerror = (error) => {
    console.error("WebSocket 错误:", error);
  };

  return Promise.resolve(response);
}

// HTTP 请求处理（用于健康检查）
function handleHttp(req: Request): Response {
  const url = new URL(req.url);
  
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      roomCount: rooms.size,
      timestamp: Date.now()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  if (url.pathname === "/stats") {
    const roomList = Array.from(rooms.values()).map(room => ({
      id: room.id,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity,
      hasJoiner: !!room.joiner
    }));
    
    return new Response(JSON.stringify({
      rooms: roomList,
      totalRooms: rooms.size
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  return new Response("信令服务器运行中", {
    headers: { "Content-Type": "text/plain" }
  });
}

// 主请求处理函数
export function handleRequest(req: Request): Response {
  if (req.headers.get("upgrade") === "websocket") {
    // 注意：这里需要返回Promise<Response>，但handleRequest返回Response
    // 我们需要调整这个函数的返回类型或实现方式
    return handleWebSocket(req) as unknown as Response;
  } else {
    return handleHttp(req);
  }
}

// 默认导出对象，包含fetch方法
export default {
  fetch: handleRequest,
};