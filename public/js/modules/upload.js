// Подключает drag&drop загрузку файлов к элементу и кнопке выбора файла.
// onFiles(FileList) вызывается с выбранными/сброшенными файлами.
export function attachUploadZone(zoneEl, onFiles) {
  let dragCounter = 0;

  zoneEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    zoneEl.classList.add('drag-over');
  });
  zoneEl.addEventListener('dragover', (e) => e.preventDefault());
  zoneEl.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      zoneEl.classList.remove('drag-over');
    }
  });
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    zoneEl.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFiles(e.dataTransfer.files);
    }
  });
}

export function openFilePicker(onFiles) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pptx,.ppt,.odp,.pdf';
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) onFiles(input.files);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}
