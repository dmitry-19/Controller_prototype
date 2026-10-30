import os
from pathlib import Path


def collect_code_to_txt(folder_path, output_file="combined_code.txt", extensions=None):
    """
    Собирает код из всех файлов с указанными расширениями в один текстовый файл

    Args:
        folder_path: Путь к папке с файлами
        output_file: Имя выходного файла
        extensions: Список расширений файлов (по умолчанию: js, ts, html, css, json, py)
    """
    if extensions is None:
        extensions = ['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json']

    folder = Path(folder_path)
    output_path = folder / output_file

    with open(output_path, 'w', encoding='utf-8') as outfile:
        # Проходим по всем файлам в папке и подпапках
        for file_path in folder.rglob('*'):
            if file_path.is_file() and file_path.suffix.lower() in extensions:
                try:
                    # Записываем разделитель и имя файла
                    relative_path = file_path.relative_to(folder)
                    outfile.write(f"\n{'=' * 80}\n")
                    outfile.write(f"ФАЙЛ: {relative_path}\n")
                    outfile.write(f"{'=' * 80}\n\n")

                    # Читаем и записываем содержимое файла
                    with open(file_path, 'r', encoding='utf-8') as infile:
                        content = infile.read()
                        outfile.write(content)
                        outfile.write("\n\n")

                    print(f"Обработан: {relative_path}")

                except UnicodeDecodeError:
                    print(f"Ошибка кодировки: {file_path} (пропущен)")
                except Exception as e:
                    print(f"Ошибка при обработке {file_path}: {e}")

    print(f"\nВсе файлы собраны в: {output_path}")


# Пример использования
if __name__ == "__main__":
    # Укажите путь к вашей папке с кодом
    source_folder = input("Введите путь к папке с кодом: ").strip()

    if os.path.exists(source_folder):
        # Опционально: укажите нужные расширения файлов
        custom_extensions = ['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss', '.json', '.py', '.java', '.cpp',
                             '.cs']

        collect_code_to_txt(
            folder_path=source_folder,
            output_file="combined_code.txt",
            extensions=custom_extensions
        )
    else:
        print("Указанная папка не существует!")