**Actor:** Estudiante

**Objetivo:** registrar un proyecto

**Excepciones:** 
- El proyecto debe tener una URL válida, puede ser una URL a un repo de Github, o a una web, o similar.


**Actor:** Estudiante

**Objetivo:** quiero tener un catálogo de proyectos

**Excepciones:** 
- Cada proyecto en escaparate debería tener una pequeña imagen en miniatura de la interfaz del proyecto. Se debería pooder coger de la URL.


**Actor:** Empresa

**Objetivo:** quiero poder tener un chatbot con un modelo local que me permita filtrar entre los alumnos según criterios de una posible vacante o nuevo puesto de trabajo.

**Excepciones:** 
- El chatbot debería estar limitado a contestar solo las preguntas que tengan que ver con el objetivo. En casa contrario debería contestar siempre de manera educada que no le está permitido contestar sobre temas que no tengan que ver con filtrar candidatos


**Actor:** Empresa

**Objetivo:** quiero poder ver las ediciones de xarxatec activa y cuando pulse en cada una de las ediciones me aparecerían las cards de cada uno de los alumnos que acabaron con éxito el programa

**Excepciones:** 
- Si un alumno al rellenar su ficha marca la opciión de no querer tener visibilidad en la web, entonces no aparecerá


**Actor:** Alumno

**Objetivo:** debo tener una sección donde mantener/rellenar mi información actualizada

**Excepciones:** 
- Solo se comunicará esa posibilidad a alumnos que hayan acabado la formación.
- Si una vez comunicado la posibilidad de acceder para rellenar los datos, el alumno no procede a rellenarlos en el siguiente mes, se marcará como inactivo. La comunicación se repetirá si los datos no se añaden a las dos semenas de mandar el primer mail, a las 3 semanas, y a los 25 días. En el momento en que un alumno rellene los datos, se elimina el envío de recordatorios por mail.

**Actor:** Sistema

**Objetivo:** mandar un mail anualmente a los alumnos que tienen información introducida (a estos los consideramos activos) haciendo recordatorio de si tienen la información actuualizada

**Actor:** Empresa

**Objetivo:** tendrá una sección donde puede ver a alumnos que actualmente trabajan en empresas socias de la asociación

**Excepciones:** 
- alumnos que no quieran que sus datos aparezcan