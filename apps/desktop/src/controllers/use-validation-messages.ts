import { useEffect } from 'react';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Vietnamese text for the browser's built-in form validation, which otherwise follows the WebView2 locale. */
export function validationMessage(field: Field): string {
  const { validity } = field;
  const input = field instanceof HTMLInputElement ? field : undefined;
  const length = field.value.length;
  if (validity.valueMissing) {
    if (field instanceof HTMLSelectElement) return 'Vui lòng chọn một mục trong danh sách.';
    if (input?.type === 'checkbox') return 'Vui lòng đánh dấu ô này để tiếp tục.';
    if (input?.type === 'file') return 'Vui lòng chọn tệp.';
    return 'Vui lòng nhập thông tin này.';
  }
  if (validity.tooShort) {
    const minimum = (field as HTMLInputElement | HTMLTextAreaElement).minLength;
    return `Vui lòng nhập ít nhất ${minimum} ký tự (hiện có ${length} ký tự).`;
  }
  if (validity.tooLong) {
    const maximum = (field as HTMLInputElement | HTMLTextAreaElement).maxLength;
    return `Vui lòng nhập tối đa ${maximum} ký tự (hiện có ${length} ký tự).`;
  }
  if (validity.badInput) return input?.type === 'number' ? 'Vui lòng nhập một số hợp lệ.' : 'Giá trị không hợp lệ.';
  if (validity.rangeUnderflow) return input?.type === 'date' ? `Ngày phải từ ${input.min} trở đi.` : `Giá trị phải lớn hơn hoặc bằng ${input?.min}.`;
  if (validity.rangeOverflow) return input?.type === 'date' ? `Ngày phải trước hoặc bằng ${input.max}.` : `Giá trị phải nhỏ hơn hoặc bằng ${input?.max}.`;
  if (validity.stepMismatch) return 'Vui lòng nhập một giá trị hợp lệ.';
  if (validity.typeMismatch) {
    if (input?.type === 'email') return 'Vui lòng nhập địa chỉ email hợp lệ.';
    if (input?.type === 'url') return 'Vui lòng nhập địa chỉ URL hợp lệ.';
    return 'Giá trị không đúng định dạng.';
  }
  if (validity.patternMismatch) return field.title || 'Giá trị không đúng định dạng yêu cầu.';
  return 'Giá trị không hợp lệ.';
}

const isField = (target: EventTarget | null): target is Field =>
  target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;

/**
 * Replaces the browser's validation bubbles with Vietnamese text for every form in the app.
 * The message is set when the field is reported invalid and cleared as soon as the user edits it,
 * so the browser re-checks the new value on the next submit.
 */
export function useVietnameseValidation() {
  useEffect(() => {
    const onInvalid = (event: Event) => {
      if (!isField(event.target)) return;
      event.target.setCustomValidity('');
      if (!event.target.validity.valid) event.target.setCustomValidity(validationMessage(event.target));
    };
    const onEdit = (event: Event) => { if (isField(event.target)) event.target.setCustomValidity(''); };
    document.addEventListener('invalid', onInvalid, true);
    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);
    return () => {
      document.removeEventListener('invalid', onInvalid, true);
      document.removeEventListener('input', onEdit, true);
      document.removeEventListener('change', onEdit, true);
    };
  }, []);
}
