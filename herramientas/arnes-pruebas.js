/* ARNES DE PRUEBA · NO va en el entregable. Simula la hoja de calculo para
   poder recorrer el flujo completo de mostrador en un navegador. */
(function(){
  ONLINE = true;
  window.print = function(){ window.__IMPRESO = (window.__IMPRESO || 0) + 1; };
  var SEQ = 0, VENTAS = {};
  var CLIENTES = {
    '1098765432': { cliente:'JUAN PEREZ', canal:'R', tipoId:'CC' },
    '900123456-7': { cliente:'AC MOTORS LTDA', canal:'M', tipoId:'NIT' }
  };
  function pad(n){ var s = String(n); while(s.length < 3) s = '0' + s; return s; }

  srv = function(fn, args, ok, err){
    args = args || [];
    setTimeout(function(){
      try{
        if(fn === 'apiEstado'){ window.__ESTADO = (window.__ESTADO || []); window.__ESTADO.push(args[0]); return; }
        if(fn === 'apiMostradorCliente'){
          var n = String(args[0] || '');
          var c = CLIENTES[n];
          ok(c ? { ok:true, existe:true, cliente:c.cliente, canal:c.canal, tipoId:c.tipoId,
                   correo:'', telefono:'', direccion:'', canalDeclarado:true }
                : { ok:true, existe:false });
          return;
        }
        if(fn === 'apiMostradorCrearCliente'){
          var d = args[0] || {};
          CLIENTES[d.numId] = { cliente:d.cliente, canal:'R', tipoId:d.tipoId };
          ok({ ok:true, creado:true, cliente:d.cliente, canal:'R', numId:d.numId,
               mensaje:d.cliente + ' creado como MINORISTA.' });
          return;
        }
        if(fn === 'apiMostradorVenta'){
          var v = args[0] || {}, det = [], sub = 0, des = 0, iva = 0;
          /* el catalogo sale del MISMO sitio que lo lee la app, para que el
             arnes no invente precios que la pantalla no tiene */
          function enCat(c){ return (DB.refs||[]).indexOf(String(c||'').toUpperCase())>=0; }
          var error = [];
          (v.lineas || []).forEach(function(l){
            if(l.esp){
              var f = [];
              if(!l.marca) f.push('la marca del carro');
              if(!l.parte) f.push('la parte');
              if(!l.mx) f.push('la medida X');
              if(!l.my) f.push('la medida Y');
              if(!l.material) f.push('el material');
              if(f.length){ error.push('Empaque especial incompleto: falta ' + f.join(', ')); return; }
              if(!(Number(l.precio) > 0)){ error.push('Empaque especial sin precio.'); return; }
              var b = Number(l.precio) * Number(l.cant), dd = b * (Number(l.dpct) || 0) / 100;
              var nn = b - dd, ii = nn * (Number(l.iva) || 19) / 100;
              sub += b; des += dd; iva += ii;
              det.push({ Codigo:'ESPECIAL',
                Descripcion:'ESPECIAL · ' + l.marca + ' · ' + l.parte + ' · ' + l.mx + ' x ' + l.my + ' · ' + l.material,
                Cantidad:Number(l.cant), Precio_unitario:Number(l.precio), Descuento_pct:Number(l.dpct) || 0,
                IVA_pct:Number(l.iva) || 19, Total_linea:Math.round(nn + ii), Costo_unitario:'',
                Es_especial:'S', Esp_marca:l.marca, Esp_parte:l.parte, Esp_medida_x:l.mx,
                Esp_medida_y:l.my, Esp_material:l.material });
              return;
            }
            var cod = String(l.cod || '').toUpperCase();
            if(!enCat(cod)){ error.push(cod + ' no esta en el catalogo.'); return; }
            var precio = precioDe(cod, v.canal === 'M' ? 'M' : 'R');
            if(!(precio > 0)){ error.push(cod + ' no tiene precio en el catalogo.'); return; }
            var ivaPct = ivaDe(cod);
            var br = precio * Number(l.cant), de = br * (Number(l.dpct) || 0) / 100;
            var ne = br - de, iv = ne * ivaPct / 100;
            sub += br; des += de; iva += iv;
            det.push({ Codigo:cod, Descripcion:desc(cod), Cantidad:Number(l.cant),
              Precio_unitario:precio, Descuento_pct:Number(l.dpct) || 0, IVA_pct:ivaPct,
              Total_linea:Math.round(ne + iv), Costo_unitario:costoDe(cod), Es_especial:'N' });
          });
          if(error.length){ ok({ ok:false, error:error.join('\n') }); return; }
          var id = 'M-' + pad(++SEQ);
          var r = { ok:true, id:id, total:Math.round(sub - des + iva), subtotal:Math.round(sub),
            descuento:Math.round(des), iva:Math.round(iva), lineas:det.length,
            especiales:det.filter(function(d){ return d.Es_especial === 'S'; }).length,
            fecha:'2026-10-16 11:30', operador:'Crstian', cliente:v.cliente,
            tipoId:v.tipoId, numId:v.numId, canal:v.canal, forma:v.forma, medio:v.medio,
            detalle:det };
          VENTAS[id] = r;
          window.__VENTAS = VENTAS;
          ok(r);
          return;
        }
        if(fn === 'apiMostradorTirilla'){
          var q = String(args[0] || '').toUpperCase();
          if(!VENTAS[q]){ ok({ ok:false, error:'La venta ' + q + ' no existe en MOS_Ventas.' }); return; }
          var c = JSON.parse(JSON.stringify(VENTAS[q])); c.reimpresion = true;
          ok(c);
          return;
        }
        if(fn === 'apiDocumento'){
          window.__DOC = args;
          ok({ ok:true, tipo:args[1], numero:args[1] === 'REMISION' ? 'R-007' : '',
               estado:args[1] === 'REMISION' ? 'EMITIDO' : 'POR_FACTURAR',
               forma:(args[3] || {}).forma, medio:(args[3] || {}).medio,
               plazo:(args[3] || {}).plazo || 0, vence:(args[3] || {}).vence || '',
               vendedor:(args[3] || {}).vendedor || '', total:0 });
          return;
        }
        if(fn === 'apiGuardar'){ window.__GUARDAR = args[0]; ok({ ok:true, escritas:(args[0] || []).length }); return; }
        if(fn === 'apiCajaResumen'){ ok({ ok:true, caja:0, cxc:[], cxp:[], alRecibir:[], movs:[] }); return; }
        if(fn === 'apiAnalisis'){ ok({ ok:true, ventas_netas:0, costo_ventas:0, margen_bruto:0, gastos_entrega:0, resultado_operativo_parcial:0, nota:'arnes' }); return; }
        if(fn === 'apiEditarFactura'){ window.__EDITAR = args; ok({ ok:true, cambios:2, total:0 }); return; }
        if(fn === 'apiGuardarCliente'){ window.__CLI = args; ok({ ok:true }); return; }
        if(fn === 'apiLogCambio'){ window.__LOG = args; ok({ ok:true }); return; }
        window.__OTRAS = (window.__OTRAS || []); window.__OTRAS.push(fn);
        if(ok) ok({ ok:true });
      }catch(e){ if(err) err(e); else console.error(e); }
    }, 5);
  };
  window.__ARNES = true;
})();
