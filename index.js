const express = require("express");
const cors = require("cors");
require("dotenv").config();
const admin = require("firebase-admin");

const app = express();
app.use(express.json());
app.use(cors());

// Inicialización de Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Firestore y estructuras globales
const db = admin.firestore();
let turnoRepartidor = 0;
let pedidosPendientes = new Map();
let temporizadoresPedidos = new Map();
let tiemposRestantes = new Map();
let asignacionesActivas = new Map();
const reasignacionesBloqueadas = new Set();

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

// ========== Función de Notificación ========== //
async function enviarNotificacionPush(token, titulo, cuerpo, dataExtra = {}) {
  const message = {
    notification: { title: titulo, body: cuerpo },
    token,
    data: dataExtra,
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("📲 Notificación enviada:", response);
  } catch (error) {
    console.error("❌ Error al enviar notificación:", error);
  }
}

// ========== Función Principal de Asignación ========== //
async function intentarAsignarRepartidor(dataPedido, pedidoId, path, repartidorAnteriorId = null) {
  try {
    const pedidoDocRef = db.doc(path);
    const pedidoSnap = await pedidoDocRef.get();

    if (!pedidoSnap.exists || pedidoSnap.data().estado !== "buscandorepa") {
      console.log(`🚫 Pedido ${pedidoId} ya fue procesado o no está disponible`);
      pedidosPendientes.delete(pedidoId);
      tiemposRestantes.delete(pedidoId);
      asignacionesActivas.delete(pedidoId);
      return false;
    }

    if (asignacionesActivas.has(pedidoId)) {
      console.log(`🔄 Pedido ${pedidoId} ya en asignación`);
      return false;
    }

    asignacionesActivas.set(pedidoId, true);

    if (repartidorAnteriorId) {
      try {
        await db.collection("repartidores")
          .doc(repartidorAnteriorId)
          .collection("pedidos")
          .doc(pedidoId)
          .delete();
        console.log(`🗑️ Eliminada asignación anterior de ${repartidorAnteriorId}`);
      } catch (error) {
        console.error("Error eliminando asignación anterior:", error);
      }
    }

    const snapshot = await db.collection("repartidores")
      .where("disponible", "==", true).get();

    if (snapshot.empty) {
      console.log("❌ No hay repartidores disponibles para", pedidoId);
      asignacionesActivas.delete(pedidoId);
      return false;
    }

    const repartidores = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const elegido = repartidores[turnoRepartidor % repartidores.length];
    turnoRepartidor++;

    const pedidoRepartidorRef = db.doc(`repartidores/${elegido.id}/pedidos/${pedidoId}`);

    await pedidoRepartidorRef.set({
      ...dataPedido,
      asignado: true,
      aceptado: false,
      timestamp: new Date(),
      pathOriginal: path,
      estadoActualizado: false,
      repartidorAsignado: elegido.id,
      asignadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });

    await pedidoDocRef.update({
      estado: "asignado",
      asignadoEn: new Date(),
      repartidorAsignado: elegido.id,
    });

    console.log(`✅ Pedido ${pedidoId} asignado a ${elegido.nombre || elegido.id}`);

    if (elegido.fcmToken) {
      await enviarNotificacionPush(
        elegido.fcmToken,
        "📦 Nuevo pedido disponible",
        `Tienes un nuevo pedido para entregar`,
        {
          pedidoId: pedidoId,
          nombreCliente: dataPedido.nombre || "Cliente",
          direccion: dataPedido.ubicacion || "",
        }
      );
    } else {
      console.log(`⚠️ Repartidor ${elegido.id} no tiene token FCM`);
    }

    // Temporizador de espera
    const temporizador = setTimeout(async () => {
      try {
        const snap = await pedidoRepartidorRef.get();

        if (snap.exists && snap.data().aceptado === true) {
          console.log(`✅ Pedido ${pedidoId} aceptado por ${elegido.id}`);
        } else {
          console.log(`❌ Pedido ${pedidoId} no aceptado, reintentar`);

          await pedidoRepartidorRef.delete();
          console.log("🗑️ Asignación temporal eliminada");

          await db.runTransaction(async (tx) => {
            const pedidoTxSnap = await tx.get(pedidoDocRef);
            if (!pedidoTxSnap.exists) return;

            const estado = pedidoTxSnap.data().estado;
            if (estado !== "buscandorepa" && estado !== "aceptado") {
              tx.update(pedidoDocRef, {
                estado: "buscandorepa",
                repartidorAsignado: null
              });
              console.log("🔄 Pedido reasignado a 'buscandorepa'");

              // Reintentar asignación
              setTimeout(() => {
                intentarAsignarRepartidor(dataPedido, pedidoId, path);
              }, 0);
            }
          });
        }
      } catch (error) {
        console.error(`🚨 Error en temporizador para ${pedidoId}:`, error);
      } finally {
        temporizadoresPedidos.delete(pedidoId);
        asignacionesActivas.delete(pedidoId);
      }
    }, 34000);

    temporizadoresPedidos.set(pedidoId, temporizador);
    return true;

  } catch (error) {
    console.error(`❌ Error al asignar pedido ${pedidoId}:`, error);
    asignacionesActivas.delete(pedidoId);
    temporizadoresPedidos.delete(pedidoId);
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

let timeout; // Para evitar disparos múltiples en poco tiempo
const repaProcesados = new Set(); // Para evitar procesar el mismo repartidor varias veces

db.collection("repartidores")
  .where("disponible", "==", true)
  .onSnapshot(snapshot => {
    clearTimeout(timeout); // Cancelar si ya hay un temporizador activo

    timeout = setTimeout(() => {
      snapshot.docChanges().forEach(change => {
        if (change.type !== "added") return;

        const nuevoRepaId = change.doc.id;

        // Evitar procesar múltiples veces al mismo repartidor
        if (repaProcesados.has(nuevoRepaId)) return;
        repaProcesados.add(nuevoRepaId);

        console.log("➕ Repa disponible:", nuevoRepaId);

        for (const [pedidoId, pedido] of pedidosPendientes) {
          if (reasignacionesBloqueadas.has(pedidoId)) {
            console.log(`🚫 Pedido ${pedidoId} bloqueado, no reasignación.`);
            continue;
          }

          // Obtener el pedido actual desde la base de datos
          db.doc(pedido.path).get().then(pedidoSnap => {
            if (
              pedidoSnap.exists &&
              pedidoSnap.data().estado === "buscandorepa" &&
              !asignacionesActivas.has(pedidoId)
            ) {
              intentarAsignarRepartidor(pedido, pedidoId, pedido.path);
            }
          }).catch(error => {
            console.error("❌ Error al obtener el pedido:", error);
          });
        }
      });

      // Limpiar repartidores procesados cada 10 segundos (opcional)
      setTimeout(() => {
        repaProcesados.clear();
      }, 10000);

    }, 1000); // Esperar 1 segundo para agrupar múltiples cambios
  });


/// ================== LISTENER REVISADO PARA LA SUB‑COLECCIÓN "pedidos" ==================
db.collectionGroup("pedidos").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    const pedido = change.doc.data();
    const pedidoId = change.doc.id;
    const pedidoRepaRef = change.doc.ref;
    const pathParts = pedidoRepaRef.path.split("/");

    // Detectar ID del repartidor desde la ruta
    const idx = pathParts.indexOf("repartidores");
    if (idx === -1 || !pathParts[idx + 1]) {
      console.warn("🔍 Ruta inesperada, salto:", pedidoRepaRef.path);
      return;
    }
    const repaId = pathParts[idx + 1];

    // Validar que pathOriginal sea una string no vacía y bien formada
    if (!pedido.pathOriginal || typeof pedido.pathOriginal !== "string") {
      console.warn(`❌ pathOriginal inválido para el pedido ${pedidoId}, salto. Valor recibido:`, pedido.pathOriginal);
      return;
    }
    const partesPath = pedido.pathOriginal.split("/");
    if (partesPath.length < 4) {
      console.warn(`❌ pathOriginal mal formado: ${pedido.pathOriginal}`);
      return;
    }
    const pedidoRef = db.doc(pedido.pathOriginal);

    // Ignorar pedidos nuevos
    if (change.type === "added") return;

    // Procesar solo modificaciones
    if (change.type === "modified") {
      // --- ACEPTADO ---
      if (pedido.aceptado === true && !pedido.estadoActualizado) {
        console.log(`✅ Repartidor ${repaId} aceptó el pedido ${pedidoId}`);

        // Limpiar timers y mapas
        if (temporizadoresPedidos.has(pedidoId)) {
          clearTimeout(temporizadoresPedidos.get(pedidoId));
          temporizadoresPedidos.delete(pedidoId);
        }
        tiemposRestantes.delete(pedidoId);
        pedidosPendientes.delete(pedidoId);
        asignacionesActivas.delete(pedidoId);

        // Actualizar pedido principal
        await pedidoRef.update({
          estado: "preparando",
          repartidorId: repaId,
          fechaAceptacion: admin.firestore.FieldValue.serverTimestamp()
        });

        // Marcar como actualizado para evitar repetición
        await pedidoRepaRef.update({ estadoActualizado: true });
      }

      // --- RECHAZADO ---
      else if (pedido.aceptado === false && !pedido.estadoActualizado) {
        console.log(`❌ Repartidor ${repaId} rechazó el pedido ${pedidoId}`);

        // Limpiar timers y mapas
        if (temporizadoresPedidos.has(pedidoId)) {
          clearTimeout(temporizadoresPedidos.get(pedidoId));
          temporizadoresPedidos.delete(pedidoId);
        }
        tiemposRestantes.delete(pedidoId);
        pedidosPendientes.delete(pedidoId);
        asignacionesActivas.delete(pedidoId);

        // Eliminar el doc de asignación
        await pedidoRepaRef.delete();

        // Sumar rechazo al repartidor
        await db.collection("repartidores").doc(repaId).update({
          rechazados: admin.firestore.FieldValue.increment(1)
        });

        // Reasignar si el pedido sigue buscando
        const snapMain = await pedidoRef.get();
        if (snapMain.exists && snapMain.data().estado === "buscandorepa") {
          console.log(`🔁 Reasignando tras rechazo de ${repaId}...`);
          setTimeout(() => {
            intentarAsignarRepartidor(
              pedidosPendientes.get(pedidoId),
              pedidoId,
              snapMain.ref.path,
              repaId
            );
          }, 2000);
        }
      }
    }
  });
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
});//NODE 4.02VERSIONPENDIENTE 
//DE SUBIR A LA NUBE