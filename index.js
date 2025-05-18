const express = require("express");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

// Inicializa Firebase Admin SDK
const serviceAccount = require("./tiendasdb-dd848-firebase-adminsdk-uh5v4-1ba3b31c20.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const PORT = process.env.PORT || 3000;

let turnoRepartidor = 0;
let pedidosPendientes = new Map();
let temporizadoresPedidos = new Map();
let tiemposRestantes = new Map();
let asignacionesActivas = new Map();

// ================== FUNCIONES PRINCIPALES ================== //
async function enviarNotificacionPush(token, titulo, cuerpo, dataExtra = {}) {
  const message = {
    notification: {
      title: titulo,
      body: cuerpo,
    },
    token: token,
    data: dataExtra, // Información adicional
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("📲 Notificación enviada:", response);
  } catch (error) {
    console.error("❌ Error al enviar notificación:", error);
  }
}


async function intentarAsignarRepartidor(pedidoData, pedidoId, path, repartidorAnteriorId = null) {
  const pedidoSnap = await db.doc(path).get();
  if (!pedidoSnap.exists || pedidoSnap.data().estado !== "buscandorepa") {
    console.log(`🚫 Pedido ${pedidoId} ya fue procesado`);
    pedidosPendientes.delete(pedidoId);
    tiemposRestantes.delete(pedidoId);
    asignacionesActivas.delete(pedidoId);
    return false;
  }

  if (asignacionesActivas.has(pedidoId)) {
    console.log(`🔄 Pedido ${pedidoId} ya está en proceso de asignación`);
    return false;
  }

  asignacionesActivas.set(pedidoId, true);

  if (repartidorAnteriorId) {
    try {
      await db.collection("repartidores").doc(repartidorAnteriorId)
        .collection("pedidos").doc(pedidoId).delete();
      console.log(`🗑️ Eliminada asignación anterior de ${repartidorAnteriorId}`);
    } catch (error) {
      console.error("Error eliminando asignación anterior:", error);
    }
  }

  const snapshot = await db.collection("repartidores").where("disponible", "==", true).get();
  if (snapshot.empty) {
    console.log("❌ No hay repartidores disponibles ahora para", pedidoId);
    asignacionesActivas.delete(pedidoId);
    return false;
  }

  const repartidores = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const elegido = repartidores[turnoRepartidor % repartidores.length];
  turnoRepartidor++;

  console.log(`🚴 Asignando pedido ${pedidoId} a: ${elegido.nombre} (${elegido.id})`);

  const tiempoExpiracion = Date.now() + 35000;
  tiemposRestantes.set(pedidoId, tiempoExpiracion);

  const pedidoRepartidorRef = db.collection("repartidores")
    .doc(elegido.id).collection("pedidos").doc(pedidoId);

  try {
    await pedidoRepartidorRef.set({
      ...pedidoData,
      asignado: true,
      aceptado: false,
      timestamp: new Date(),
      pathOriginal: path,
      tiempoExpiracion: new Date(tiempoExpiracion),
      estadoActualizado: false,
      repartidorAsignado: elegido.id
    });
   
    // Obtener el token del repartidor
if (elegido.fcmToken) {
  await enviarNotificacionPush(
    elegido.fcmToken,
    "📦 Nuevo pedido disponible",
    `Tienes un nuevo pedido para entregar`,
    {
      pedidoId: pedidoId,
      nombreCliente: pedidoData.nombre || "Cliente",
      direccion: pedidoData.ubicacion || "",
    }
  );
} else {
  console.log(`⚠️ Repartidor ${elegido.id} no tiene token FCM`);
}

    const temporizador = setTimeout(async () => {
      try {
        const snap = await pedidoRepartidorRef.get();
        if (snap.exists && !snap.data().aceptado) {
          console.log(`⏰ Tiempo agotado para ${elegido.nombre} (pedido ${pedidoId})`);
          
          await pedidoRepartidorRef.delete();
          if (pedidosPendientes.has(pedidoId)) {
            console.log(`🔄 Reasignando pedido ${pedidoId}`);
            intentarAsignarRepartidor(
              pedidosPendientes.get(pedidoId), 
              pedidoId, 
              path, 
              elegido.id
            );
          }
        }
      } catch (error) {
        console.error(`Error al reasignar pedido ${pedidoId}:`, error);
      } finally {
        asignacionesActivas.delete(pedidoId);
      }
    }, 35000);

    temporizadoresPedidos.set(pedidoId, temporizador);
    return true;
  } catch (error) {
    console.error(`Error al asignar pedido ${pedidoId}:`, error);
    asignacionesActivas.delete(pedidoId);
    return false;
  }
}

// ================== LISTENERS FIRESTORE ================== //

db.collectionGroup("ordenes").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    const pedido = change.doc.data();
    const pedidoId = change.doc.id;
    const path = change.doc.ref.path;

    if (change.type === "modified" && pedido.estado === "buscandorepa") {
      console.log("🟡 Pedido esperando repartidor:", pedidoId);
      if (!pedidosPendientes.has(pedidoId)) {
        const tiempoExpira = Date.now() + 35000;

        pedidosPendientes.set(pedidoId, { ...pedido, path });
        tiemposRestantes.set(pedidoId, tiempoExpira);

        const temporizadorGlobal = setTimeout(async () => {
          try {
            const pedidoRef = db.doc(path);
            const pedidoSnap = await pedidoRef.get();
            if (pedidoSnap.exists && pedidoSnap.data().estado === "buscandorepa") {
              await pedidoRef.update({ estado: "rechazado" });
              console.log(`⏰ Pedido ${pedidoId} rechazado por falta de repartidor.`);
            }
          } catch (error) {
            console.error(`Error al actualizar el estado del pedido ${pedidoId}:`, error);
          } finally {
            pedidosPendientes.delete(pedidoId);
            tiemposRestantes.delete(pedidoId);
            temporizadoresPedidos.delete(pedidoId);
            asignacionesActivas.delete(pedidoId);
          }
        }, 7 * 60 * 1000);

        temporizadoresPedidos.set(pedidoId, temporizadorGlobal);
        intentarAsignarRepartidor(pedido, pedidoId, path);
      }
    }
  });
});

db.collection("repartidores")
  .where("disponible", "==", true)
  .onSnapshot(async (snapshot) => {
    if (!snapshot.empty) {
      console.log("✅ Hay repartidores disponibles, verificando pedidos...");
      
      for (const [pedidoId, pedido] of pedidosPendientes) {
        const pedidoRef = db.doc(pedido.path);
        const pedidoSnap = await pedidoRef.get();
        
        if (pedidoSnap.exists && pedidoSnap.data().estado === "buscandorepa") {
          if (!asignacionesActivas.has(pedidoId)) {
            await intentarAsignarRepartidor(pedido, pedidoId, pedido.path);
          }
        }
      }
    }
  });

db.collection("repartidores").onSnapshot(async (snapshot) => {
  for (const doc of snapshot.docs) {
    const repaId = doc.id;
    const pedidosSnapshot = await db.collection("repartidores").doc(repaId).collection("pedidos").get();

    for (const pedidoDoc of pedidosSnapshot.docs) {
      const pedido = pedidoDoc.data();
      const pedidoId = pedidoDoc.id;

      if (pedido.estadoActualizado || !pedido.pathOriginal) continue;

      const pedidoRef = db.doc(pedido.pathOriginal);
      const pedidoRepaRef = db.collection("repartidores").doc(repaId).collection("pedidos").doc(pedidoId);

      if (pedido.aceptado === true) {
        console.log(`✅ Repartidor ${repaId} aceptó el pedido ${pedidoId}`);
        try {
          if (temporizadoresPedidos.has(pedidoId)) {
            clearTimeout(temporizadoresPedidos.get(pedidoId));
            temporizadoresPedidos.delete(pedidoId);
          }
          tiemposRestantes.delete(pedidoId);
          pedidosPendientes.delete(pedidoId);
          asignacionesActivas.delete(pedidoId);

          await pedidoRef.update({
            estado: "preparando",
            repartidorId: repaId,
            fechaAceptacion: admin.firestore.FieldValue.serverTimestamp()
          });

          await pedidoRepaRef.update({ estadoActualizado: true });
        } catch (err) {
          console.error("⚠️ Error al actualizar pedido aceptado:", err);
        }
      } else if (pedido.aceptado === false) {
        console.log(`❌ Repartidor ${repaId} rechazó el pedido ${pedidoId}`);
        try {
          await pedidoRepaRef.delete();
          await db.collection("repartidores").doc(repaId).update({
            rechazados: admin.firestore.FieldValue.increment(1),
          });

          asignacionesActivas.delete(pedidoId);
          temporizadoresPedidos.delete(pedidoId);
          tiemposRestantes.delete(pedidoId);

          if (pedido.pathOriginal && pedidosPendientes.has(pedidoId)) {
            setTimeout(() => {
              console.log(`🔁 Intentando reasignar pedido ${pedidoId}...`);
              intentarAsignarRepartidor(
                pedidosPendientes.get(pedidoId), 
                pedidoId, 
                pedido.pathOriginal
              );
            }, 2000);
          }
        } catch (err) {
          console.error("🔥 Error al eliminar pedido rechazado:", err);
        }
      }
    }
  }
});

// ================== ENDPOINTS ================== //

app.get("/tiempo-restante/:pedidoId", async (req, res) => {
  const pedidoId = req.params.pedidoId;
  try {
    if (tiemposRestantes.has(pedidoId)) {
      const segundos = Math.max(0, Math.floor(
        (tiemposRestantes.get(pedidoId) - Date.now()) / 1000
      ));
      return res.json({ segundosRestantes: segundos });
    }
    
    const pedidoSnapshot = await db.collectionGroup("pedidos")
      .where("__name__", "==", `repartidores/*/pedidos/${pedidoId}`)
      .get();

    if (!pedidoSnapshot.empty) {
      const pedido = pedidoSnapshot.docs[0].data();
      if (pedido.tiempoExpiracion) {
        const segundos = Math.max(0, Math.floor(
          (pedido.tiempoExpiracion.toDate().getTime() - Date.now()) / 1000
        ));
        tiemposRestantes.set(pedidoId, pedido.tiempoExpiracion.toDate().getTime());
        return res.json({ segundosRestantes: segundos });
      }
    }
    
    res.status(404).json({ error: "Pedido no encontrado o ya asignado" });
  } catch (error) {
    console.error("Error en /tiempo-restante:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.get("/", (req, res) => {
  res.send("🚀 BotNode Mejorado - Control de reasignaciones");
});

app.listen(PORT, () => {
  console.log(`🔥 Servidor activo en http://localhost:${PORT}`);
});