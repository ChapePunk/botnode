const express = require("express");
const cors = require("cors");
require("dotenv").config();
const admin = require("firebase-admin");

// Configuración inicial
const app = express();
app.use(express.json());
app.use(cors());

// Inicialización de Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Firestore y estructuras de datos
const db = admin.firestore();
let turnoRepartidor = 0;
const pedidosPendientes = new Map();
const temporizadoresPedidos = new Map();
const tiemposRestantes = new Map();
const asignacionesActivas = new Map();
const reasignacionesBloqueadas = new Set();

// Constantes de configuración
const TIEMPO_ESPERA_REPARTIDOR = 34000; // 34 segundos para aceptar pedido
const TIEMPO_EXPIRACION_PEDIDO = 7 * 60 * 1000; // 7 minutos para expirar pedido

// ========== FUNCIONES AUXILIARES ========== //

/**
 * Envía notificación push al repartidor
 */
async function enviarNotificacionPush(token, titulo, cuerpo, dataExtra = {}) {
  const message = {
    notification: { title: titulo, body: cuerpo },
    token,
    data: dataExtra,
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("📲 Notificación enviada:", response);
    return true;
  } catch (error) {
    console.error("❌ Error al enviar notificación:", error);
    return false;
  }
}

/**
 * Limpia los recursos asociados a un pedido
 */
function limpiarRecursosPedido(pedidoId) {
  if (temporizadoresPedidos.has(pedidoId)) {
    clearTimeout(temporizadoresPedidos.get(pedidoId));
    temporizadoresPedidos.delete(pedidoId);
  }
  tiemposRestantes.delete(pedidoId);
  pedidosPendientes.delete(pedidoId);
  asignacionesActivas.delete(pedidoId);
  reasignacionesBloqueadas.delete(pedidoId);
}

// ========== FUNCIÓN PRINCIPAL DE ASIGNACIÓN ========== //

async function intentarAsignarRepartidor(dataPedido, pedidoId, path, repartidorAnteriorId = null) {
  // Verificar si ya está en proceso de asignación
  if (asignacionesActivas.has(pedidoId)) {
    console.log(`🔄 Pedido ${pedidoId} ya en asignación`);
    return false;
  }

  try {
    // Bloquear para evitar asignaciones concurrentes
    asignacionesActivas.set(pedidoId, true);
    
    const pedidoDocRef = db.doc(path);
    const pedidoSnap = await pedidoDocRef.get();

    // Verificar si el pedido aún está disponible
    if (!pedidoSnap.exists || pedidoSnap.data().estado !== "buscandorepa") {
      console.log(`🚫 Pedido ${pedidoId} ya fue procesado o no está disponible`);
      limpiarRecursosPedido(pedidoId);
      return false;
    }

    // Eliminar asignación anterior si existe
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

    // Obtener repartidores disponibles
    const snapshot = await db.collection("repartidores")
      .where("disponible", "==", true)
      .where("activo", "==", true) // Filtro adicional para repartidores activos
      .get();

    if (snapshot.empty) {
      console.log("❌ No hay repartidores disponibles para", pedidoId);
      return false;
    }

    // Seleccionar repartidor (round-robin)
    const repartidores = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const elegido = repartidores[turnoRepartidor % repartidores.length];
    turnoRepartidor++;

    console.log(`🔍 Intentando asignar ${pedidoId} a ${elegido.nombre || elegido.id}`);

    // Crear asignación en subcolección del repartidor
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
      tiempoExpiracion: new Date(Date.now() + TIEMPO_ESPERA_REPARTIDOR)
    });

    // Actualizar estado principal del pedido
    await pedidoDocRef.update({
      estado: "asignado",
      asignadoEn: admin.firestore.FieldValue.serverTimestamp(),
      repartidorAsignado: elegido.id,
      intentosAsignacion: admin.firestore.FieldValue.increment(1)
    });

    console.log(`✅ Pedido ${pedidoId} asignado a ${elegido.nombre || elegido.id}`);

    // Enviar notificación al repartidor
    if (elegido.fcmToken) {
      await enviarNotificacionPush(
        elegido.fcmToken,
        "📦 Nuevo pedido disponible",
        `Tienes un nuevo pedido para entregar`,
        {
          pedidoId: pedidoId,
          nombreCliente: dataPedido.nombre || "Cliente",
          direccion: dataPedido.ubicacion || "",
          tiempoLimite: TIEMPO_ESPERA_REPARTIDOR.toString()
        }
      );
    } else {
      console.log(`⚠️ Repartidor ${elegido.id} no tiene token FCM`);
    }

    // Configurar temporizador de espera para aceptación
    const temporizador = setTimeout(async () => {
      try {
        const snap = await pedidoRepartidorRef.get();

        if (snap.exists) {
          if (snap.data().aceptado === true) {
            console.log(`✅ Pedido ${pedidoId} aceptado por ${elegido.id}`);
          } else {
            console.log(`⌛ Tiempo agotado: Pedido ${pedidoId} no aceptado por ${elegido.id}`);

            // Eliminar asignación temporal
            await pedidoRepartidorRef.delete();
            
            // Revertir estado si no fue aceptado
            await db.runTransaction(async (tx) => {
              const pedidoTxSnap = await tx.get(pedidoDocRef);
              if (!pedidoTxSnap.exists) return;

              const estado = pedidoTxSnap.data().estado;
              if (estado === "asignado") {
                tx.update(pedidoDocRef, {
                  estado: "buscandorepa",
                  repartidorAsignado: null
                });
                
                // Reintentar asignación
                setTimeout(() => {
                  intentarAsignarRepartidor(dataPedido, pedidoId, path, elegido.id);
                }, 1000);
              }
            });
          }
        }
      } catch (error) {
        console.error(`🚨 Error en temporizador para ${pedidoId}:`, error);
      } finally {
        limpiarRecursosPedido(pedidoId);
      }
    }, TIEMPO_ESPERA_REPARTIDOR);

    temporizadoresPedidos.set(pedidoId, temporizador);
    return true;

  } catch (error) {
    console.error(`❌ Error al asignar pedido ${pedidoId}:`, error);
    limpiarRecursosPedido(pedidoId);
    return false;
  }
}

// ================== LISTENERS FIRESTORE ================== //

/**
 * Listener para pedidos que necesitan repartidor
 */
db.collectionGroup("ordenes").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type !== "modified") return;

    const pedido = change.doc.data();
    const pedidoId = change.doc.id;
    const path = change.doc.ref.path;

    if (pedido.estado === "buscandorepa") {
      console.log("🟡 Pedido esperando repartidor:", pedidoId);
      
      // Actualizar información del pedido en el mapa
      pedidosPendientes.set(pedidoId, { ...pedido, path });
      tiemposRestantes.set(pedidoId, Date.now() + TIEMPO_EXPIRACION_PEDIDO);

      // Limpiar temporizador anterior si existe
      if (temporizadoresPedidos.has(pedidoId)) {
        clearTimeout(temporizadoresPedidos.get(pedidoId));
      }

      // Configurar temporizador de expiración global
      temporizadoresPedidos.set(pedidoId, setTimeout(async () => {
        try {
          const pedidoRef = db.doc(path);
          const pedidoSnap = await pedidoRef.get();
          
          if (pedidoSnap.exists && pedidoSnap.data().estado === "buscandorepa") {
            await pedidoRef.update({ estado: "rechazado" });
            console.log(`⏰ Pedido ${pedidoId} rechazado por falta de repartidor.`);
          }
        } catch (error) {
          console.error(`Error al actualizar estado del pedido ${pedidoId}:`, error);
        } finally {
          limpiarRecursosPedido(pedidoId);
        }
      }, TIEMPO_EXPIRACION_PEDIDO));

      // Intentar asignación si no está en proceso
      if (!asignacionesActivas.has(pedidoId)) {
        intentarAsignarRepartidor(pedido, pedidoId, path);
      }
    }
  });
});

/**
 * Listener para repartidores disponibles
 */
db.collection("repartidores")
  .where("disponible", "==", true)
  .onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type !== "added") return;
      
      const nuevoRepaId = change.doc.id;
      console.log("➕ Repa disponible:", nuevoRepaId);

      // Intentar asignar pedidos pendientes a este repartidor
      for (const [pedidoId, pedido] of pedidosPendientes) {
        if (reasignacionesBloqueadas.has(pedidoId) || asignacionesActivas.has(pedidoId)) {
          continue;
        }

        db.doc(pedido.path).get().then(pedidoSnap => {
          if (pedidoSnap.exists && pedidoSnap.data().estado === "buscandorepa") {
            intentarAsignarRepartidor(pedido, pedidoId, pedido.path);
          }
        });
      }
    });
  });

/**
 * Listener para respuestas de repartidores (aceptar/rechazar)
 */
db.collectionGroup("pedidos").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type !== "modified") return;

    const pedido = change.doc.data();
    const pedidoId = change.doc.id;
    const pedidoRepaRef = change.doc.ref;
    
    // Extraer ID del repartidor de la ruta del documento
    const pathParts = pedidoRepaRef.path.split("/");
    const repaId = pathParts[pathParts.indexOf("repartidores") + 1];
    const pedidoRef = db.doc(pedido.pathOriginal);

    // Manejar aceptación
    if (pedido.aceptado === true && !pedido.estadoActualizado) {
      console.log(`✅ Repartidor ${repaId} aceptó el pedido ${pedidoId}`);
      
      limpiarRecursosPedido(pedidoId);

      await pedidoRef.update({
        estado: "preparando",
        repartidorId: repaId,
        fechaAceptacion: admin.firestore.FieldValue.serverTimestamp()
      });

      await pedidoRepaRef.update({ estadoActualizado: true });
    }
    // Manejar rechazo
    else if (pedido.aceptado === false && !pedido.estadoActualizado) {
      console.log(`❌ Repartidor ${repaId} rechazó el pedido ${pedidoId}`);
      
      limpiarRecursosPedido(pedidoId);
      reasignacionesBloqueadas.add(pedidoId); // Evitar reasignación inmediata

      await pedidoRepaRef.delete();
      await db.collection("repartidores").doc(repaId)
              .update({ rechazados: admin.firestore.FieldValue.increment(1) });

      // Verificar si el pedido sigue necesitando repartidor
      const snapMain = await pedidoRef.get();
      if (snapMain.exists && snapMain.data().estado === "buscandorepa") {
        console.log(`🔁 Reasignando tras rechazo de ${repaId}...`);
        
        setTimeout(() => {
          reasignacionesBloqueadas.delete(pedidoId);
          intentarAsignarRepartidor(
            snapMain.data(),
            pedidoId,
            snapMain.ref.path,
            repaId
          );
        }, 2000);
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
        return res.json({ segundosRestantes: segundos });
      }
    }
    
    res.status(404).json({ error: "Pedido no encontrado o ya asignado" });
  } catch (error) {
    console.error("Error en /tiempo-restante:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.get("/estado-asignacion", (req, res) => {
  res.json({
    pedidosPendientes: Array.from(pedidosPendientes.keys()),
    asignacionesActivas: Array.from(asignacionesActivas.keys()),
    repartidoresDisponibles: turnoRepartidor
  });
});

app.get("/", (req, res) => {
  res.send("🚀 Bot de Asignación de Pedidos - Versión Optimizada");
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Servidor activo en http://localhost:${PORT}`);
  console.log("🔍 Monitoreo de asignaciones activado");
});
