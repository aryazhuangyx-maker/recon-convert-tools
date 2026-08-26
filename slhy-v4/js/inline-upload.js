// 内联上传逻辑（绕过 ES Module + file:// 协议问题）
window.uploadMapping = function() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.onchange = function() {
    var file = input.files[0];
    if (!file) return;
    var defaultName = file.name.replace(/\.(xlsx|xls)$/i, '').replace(/合同台账|合同/, '').trim();
    var name = prompt('请输入台账名称（如2026年台账）：', defaultName || '');
    if (!name) return;
    var btn = document.querySelector('#mode-picker button');
    if (btn) btn.disabled = true;
    (window._uploadMappingFile || Promise.reject(new Error('模块加载中，请稍后重试')))
      .call(null, file, name)
      .then(function(r) {
        if (r.error) { alert('上传失败：' + r.error); return; }
        var newName = r.item.name;
        var count = Object.keys(r.parsed.ledger || {}).length;
        // 直接填充下拉框（绕过 async loadMappings）
        var sel = document.getElementById('mapping-select');
        if (sel) {
          sel.options.length = 0;
          var opt0 = document.createElement('option');
          opt0.value = '';
          opt0.textContent = '— 请选择 —';
          sel.appendChild(opt0);
          var opt = document.createElement('option');
          opt.value = newName;
          opt.textContent = newName + '（' + count + '项）';
          opt.selected = true;
          sel.appendChild(opt);
        }
        window.mappingName = newName;
        if (typeof window.loadMappingsRef === 'function') window.loadMappingsRef();
        if (typeof window.selectMappingRef === 'function') window.selectMappingRef(newName);
        alert('✅ 上传成功！已加载 ' + count + ' 个合同，台账名称：' + newName);
      })
      .catch(function(e) { alert('解析失败：' + e.message); })
      .finally(function() { if (btn) btn.disabled = false; });
  };
  input.click();
};
window._uploadMappingFile = null;
